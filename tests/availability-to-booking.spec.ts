import { expect, test } from '@playwright/test';
import { availableSlots, fixtureTopology } from './support/api';
import { env } from './support/environment';
import { login, selectMaterialOption } from './support/ui';

test.describe('Disponibilidad y creación de turnos', () => {
  test('abre Crear turno con todos los datos del horario precargados', async ({ page, request }) => {
    const topology = await fixtureTopology(request);
    const slots = await availableSlots(request, topology);
    expect(slots.length, 'El fixture E2E no tiene horarios disponibles').toBeGreaterThan(0);
    const selectedSlot = slots[0];
    const selectedTime = time(selectedSlot.startsAt);

    await login(page);
    await page.goto(`/${env.businessSlug}/availability`);
    await expect(page.getByRole('heading', { name: 'Disponibilidad', exact: true })).toBeVisible();

    const filters = page.getByRole('region', { name: 'Filtros de disponibilidad' });
    await selectMaterialOption(page, filters, 'Sucursal', env.branchName);
    await selectMaterialOption(page, filters, 'Servicio', env.serviceName);
    const professional = filters.getByLabel('Profesional', { exact: true });
    if (await professional.isVisible().catch(() => false)) {
      await selectMaterialOption(page, filters, 'Profesional', env.resourceName);
    }

    const weeks = weekDistance(new Date(), parseDate(env.bookingDate));
    expect(weeks, 'La fecha E2E no puede estar en una semana pasada').toBeGreaterThanOrEqual(0);
    for (let index = 0; index < weeks; index += 1) {
      const overview = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname.endsWith('/availability/overview'),
      );
      await page.getByRole('button', { name: 'Semana siguiente' }).click();
      expect((await overview).ok()).toBeTruthy();
    }

    const weekday = new Intl.DateTimeFormat('es-AR', { weekday: 'long' }).format(
      parseDate(env.bookingDate),
    );
    const day = page.locator('.day-card').filter({
      has: page.getByRole('heading', { name: weekday, exact: true }),
    });
    await expect(day).toBeVisible();
    const slotButton = day.getByRole('button', { name: selectedTime, exact: true });
    await expect(slotButton).toBeVisible();
    await slotButton.click();

    await expect(page).toHaveURL(/\/booking\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get('businessId')).toBe(topology.businessId);
    expect(url.searchParams.get('branchId')).toBe(topology.branchId);
    expect(url.searchParams.get('serviceId')).toBe(topology.serviceId);
    expect(url.searchParams.get('resourceId')).toBe(topology.resourceId);
    expect(url.searchParams.get('startsAt')).toContain(`${env.bookingDate}T${selectedTime}`);
    expect(url.searchParams.get('source')).toBe('DIRECT_LINK');

    await expect(page.getByRole('heading', { name: 'Reserva', exact: true })).toBeVisible();
    await expect(page.locator('mat-card')).toContainText(env.businessName);
    await expect(page.locator('mat-card')).toContainText(env.branchName);
    await expect(page.locator('mat-card')).toContainText(env.serviceName);
    await expect(page.locator('mat-card')).toContainText(env.resourceName);
    await expect(page.getByLabel('Nombre y apellido')).toBeVisible();
  });
});

function time(value: string): string {
  const timePart = value.includes('T') ? value.split('T')[1] : value;
  return timePart.slice(0, 5);
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function monday(value: Date): Date {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const weekday = date.getDay();
  date.setDate(date.getDate() - (weekday === 0 ? 6 : weekday - 1));
  return date;
}

function weekDistance(from: Date, to: Date): number {
  return Math.round((monday(to).getTime() - monday(from).getTime()) / 604_800_000);
}
