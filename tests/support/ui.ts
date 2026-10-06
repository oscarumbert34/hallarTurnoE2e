import { expect, Locator, Page } from '@playwright/test';
import { env, routes } from './environment';

export async function login(page: Page): Promise<void> {
  await page.goto(routes.login);
  await page.getByLabel('Email').fill(env.email);
  await page.getByLabel('Contraseña').fill(env.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(routes.bookings)}(?:\\?.*)?$`));
}

export async function selectMaterialOption(
  page: Page,
  form: Locator,
  label: string,
  option: string,
): Promise<void> {
  await form.getByLabel(label, { exact: true }).click();
  await page.getByRole('option').filter({ hasText: option }).first().click();
}

export async function fillSearch(page: Page): Promise<Locator> {
  const form = page.locator('form.search-form');
  await expect(form).toBeVisible();
  await selectMaterialOption(page, form, 'Sucursal', env.branchName);
  await selectMaterialOption(page, form, 'Servicio', env.serviceName);
  await form.getByLabel('Fecha', { exact: true }).fill(dateForMaterialInput(env.bookingDate));
  const timeInputs = form.locator('input.native-time-input');
  await timeInputs.nth(0).evaluate((input: HTMLInputElement) => {
    input.value = '00:00';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await timeInputs.nth(1).evaluate((input: HTMLInputElement) => {
    input.value = '23:30';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await form.getByRole('button', { name: 'Buscar', exact: true }).click();
  const result = page.locator('mat-card.result-card').filter({ hasText: env.businessName }).filter({ hasText: env.serviceName });
  await expect(result).toBeVisible();
  return result;
}

export async function chooseAvailableSlot(result: Locator, excludedTime?: string): Promise<string> {
  const buttons = result.locator('.slots button');
  await expect(buttons.first()).toBeVisible();
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const label = (await button.innerText()).trim();
    if (!excludedTime || !label.includes(excludedTime)) {
      await button.click();
      return label;
    }
  }
  throw new Error('No quedó un segundo horario libre para el escenario público.');
}

export async function completeCustomer(page: Page, customer: { name: string; phone: string; email: string }): Promise<void> {
  await page.getByLabel('Nombre y apellido').fill(customer.name);
  await page.getByLabel('Teléfono').fill(customer.phone);
  await page.getByLabel('Teléfono').blur();
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  await expect(email).toBeVisible();
  await email.fill(customer.email);
  await expect(page.getByRole('button', { name: 'Confirmar turno' })).toBeEnabled();
}

export async function showBookingsForDate(page: Page, status = 'ACTIVE'): Promise<void> {
  await page.goto(routes.bookings);
  const form = page.locator('form.booking-filter');
  await form.getByLabel('Fecha', { exact: true }).fill(dateForMaterialInput(env.bookingDate));
  await form.getByLabel('Estado', { exact: true }).click();
  const statusLabels: Record<string, string> = {
    ACTIVE: 'Activas',
    CONFIRMED: 'Confirmadas',
    PENDING: 'Pendientes',
    CANCELLED: 'Canceladas',
    ALL: 'Todas',
  };
  await page.getByRole('option', { name: statusLabels[status], exact: true }).click();
  const bookingsResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      url.pathname.endsWith('/bookings') &&
      url.searchParams.get('date') === env.bookingDate
    );
  });
  await form.getByRole('button', { name: 'Ver reservas' }).click();
  const response = await bookingsResponse;
  expect(response.ok(), `Falló la carga de agenda: ${response.status()}`).toBeTruthy();
  await expect(form.getByRole('button', { name: 'Ver reservas' })).toBeEnabled();
}

export async function findBookingAcrossPages(page: Page, customerName: string): Promise<Locator> {
  const row = page.locator('.week-booking-row').filter({ hasText: customerName });

  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    if ((await row.count()) > 0) {
      return row;
    }

    const next = page.getByRole('button', { name: 'Siguiente', exact: true });
    if ((await next.count()) === 0 || (await next.isDisabled())) {
      break;
    }

    const previousLabel = await page.getByText(/^Página \d+ de \d+/).innerText();
    await next.click();
    await expect(page.getByText(/^Página \d+ de \d+/)).not.toHaveText(previousLabel);
  }

  throw new Error(`No se encontró la reserva de ${customerName} en ninguna página de la agenda.`);
}

function dateForMaterialInput(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
