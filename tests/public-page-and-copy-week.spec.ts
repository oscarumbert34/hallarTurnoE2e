import { expect, test } from '@playwright/test';
import {
  authenticatedFixture,
  cancelBooking,
  createBookingFixture,
  getBusinessConfiguration,
  updateBusinessConfiguration,
} from './support/api';
import { env, routes } from './support/environment';
import { login, selectMaterialOption } from './support/ui';

test.describe('página pública del negocio', () => {
  test('publica identidad, sucursal, servicio y datos de contacto', async ({ page }) => {
    await page.goto(routes.publicBusiness);

    await expect(page.getByRole('heading', { level: 1, name: env.businessName })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nuestros servicios' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: env.serviceName })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reservar turno' })).toBeVisible();
  });

  test('muestra correctamente los turnos disponibles de hoy', async ({ page, request }) => {
    const fixture = await authenticatedFixture(request);
    const headers = { Authorization: `Bearer ${fixture.token}` };
    const today = localIsoDate();
    const day = dayOfWeek(today);
    const publicResponse = await request.get(
      `${env.backendUrl}/api/v1/public/businesses/${encodeURIComponent(env.businessSlug)}`,
    );
    expect(publicResponse.ok()).toBeTruthy();
    const publicBusiness = (await publicResponse.json()) as {
      branches: Array<{ id: string; name: string }>;
    };
    const branch = publicBusiness.branches.find((item) => item.name === env.branchName);
    expect(branch, `No existe la sucursal ${env.branchName}`).toBeTruthy();

    const resourcesResponse = await request.get(
      `${env.backendUrl}/api/v1/branches/${branch!.id}/resources`,
      { headers },
    );
    expect(resourcesResponse.ok()).toBeTruthy();
    const resources = (await resourcesResponse.json()) as ResourceFixture[];
    const resource = resources.find((item) => item.visibleName === env.resourceName);
    expect(resource, `No existe el recurso ${env.resourceName}`).toBeTruthy();
    const originalSchedule = resource!.weeklySchedule;

    const exceptionsResponse = await request.get(
      `${env.backendUrl}/api/v1/branches/${branch!.id}/schedule-exceptions`,
      { headers },
    );
    expect(exceptionsResponse.ok()).toBeTruthy();
    const existingException = ((await exceptionsResponse.json()) as ScheduleException[]).find(
      (item) => item.date === today,
    );
    let createdExceptionId: string | undefined;

    try {
      const resourceUpdate = await request.put(
        `${env.backendUrl}/api/v1/resources/${resource!.id}`,
        {
          headers,
          data: {
            visibleName: resource!.visibleName,
            type: resource!.type,
            status: resource!.status,
            serviceOfferingIds: resource!.serviceOfferingIds,
            weeklySchedule: originalSchedule.map((schedule) =>
              schedule.day === day
                ? { ...schedule, timeRanges: [{ start: '00:00', end: '23:59' }] }
                : schedule,
            ),
            absences: resource!.absences,
          },
        },
      );
      expect(resourceUpdate.ok(), `No se pudo preparar el recurso: ${await resourceUpdate.text()}`).toBeTruthy();

      const exceptionPayload = {
        date: today,
        type: 'CUSTOM_HOURS',
        startTime: '00:00',
        endTime: '23:59',
        reason: 'Fixture E2E disponibilidad de hoy',
      };
      const exceptionResponse = existingException
        ? await request.put(
            `${env.backendUrl}/api/v1/branches/${branch!.id}/schedule-exceptions/${existingException.id}`,
            { headers, data: exceptionPayload },
          )
        : await request.post(
            `${env.backendUrl}/api/v1/branches/${branch!.id}/schedule-exceptions`,
            { headers, data: exceptionPayload },
          );
      expect(exceptionResponse.ok(), `No se pudo preparar la sucursal: ${await exceptionResponse.text()}`).toBeTruthy();
      if (!existingException) {
        createdExceptionId = ((await exceptionResponse.json()) as ScheduleException).id;
      }

      await page.goto(routes.publicBusiness);
      const service = page.locator('article').filter({ hasText: env.serviceName });
      await service.getByRole('button', { name: 'Reservar', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: env.serviceName })).toBeVisible();
      const todayInput = dialog.getByLabel('Seleccioná una fecha');
      await expect(todayInput).toHaveAttribute('min', today);
      await expect(todayInput).toHaveValue(materialDateWithoutPadding(today));
      await expect(dialog.getByRole('heading', { name: 'Horarios disponibles' })).toBeVisible();
      const slots = dialog.locator('.slots button');
      await expect(slots.first()).toBeVisible();
      await expect(slots.first()).toContainText(env.resourceName);
      expect((await slots.first().innerText()).trim()).toMatch(/^\d{2}:\d{2}/);
    } finally {
      await request.put(`${env.backendUrl}/api/v1/resources/${resource!.id}`, {
        headers,
        data: {
          visibleName: resource!.visibleName,
          type: resource!.type,
          status: resource!.status,
          serviceOfferingIds: resource!.serviceOfferingIds,
          weeklySchedule: originalSchedule,
          absences: resource!.absences,
        },
      });
      if (existingException) {
        await request.put(
          `${env.backendUrl}/api/v1/branches/${branch!.id}/schedule-exceptions/${existingException.id}`,
          {
            headers,
            data: {
              date: existingException.date,
              type: existingException.type,
              startTime: existingException.startTime,
              endTime: existingException.endTime,
              reason: existingException.reason,
            },
          },
        );
      } else if (createdExceptionId) {
        await request.delete(
          `${env.backendUrl}/api/v1/branches/${branch!.id}/schedule-exceptions/${createdExceptionId}`,
          { headers },
        );
      }
    }
  });

  test('una empresa habilitada permite iniciar una reserva pública', async ({ page, request }) => {
    const fixture = await authenticatedFixture(request);
    const original = await getBusinessConfiguration(request, fixture);

    try {
      const update = await updateBusinessConfiguration(request, fixture, {
        internalBookingCreation: false,
      });
      expect(update.ok(), 'No se pudo habilitar temporalmente la reserva pública').toBeTruthy();

      await page.goto(routes.publicBusiness);
      await page.getByRole('button', { name: 'Reservar turno' }).click();
      await expect(page).toHaveURL(new RegExp(`${routes.search.replaceAll('/', '\\/')}(?:\\?.*)?$`));
      await expect(page.locator('form.search-form')).toBeVisible();
    } finally {
      await updateBusinessConfiguration(request, fixture, original);
    }
  });

  test('una empresa de carga interna rechaza la reserva pública y ofrece WhatsApp manual', async ({
    page,
    request,
  }) => {
    const fixture = await authenticatedFixture(request);
    const originalConfiguration = await getBusinessConfiguration(request, fixture);
    const businessResponse = await request.get(
      `${env.backendUrl}/api/v1/businesses/${fixture.businessId}`,
      { headers: { Authorization: `Bearer ${fixture.token}` } },
    );
    expect(businessResponse.ok()).toBeTruthy();
    const originalBusiness = (await businessResponse.json()) as {
      publicDescription?: string | null;
      aboutUs?: string | null;
      whatsapp?: string | null;
      instagram?: string | null;
    };
    const whatsapp = '5491112345678';

    try {
      const configurationUpdate = await updateBusinessConfiguration(request, fixture, {
        internalBookingCreation: true,
      });
      expect(configurationUpdate.ok(), 'No se pudo activar la carga interna').toBeTruthy();
      const profileUpdate = await request.put(
        `${env.backendUrl}/api/v1/businesses/${fixture.businessId}/public-profile`,
        {
          headers: { Authorization: `Bearer ${fixture.token}` },
          data: {
            publicDescription: originalBusiness.publicDescription,
            aboutUs: originalBusiness.aboutUs,
            whatsapp,
            instagram: originalBusiness.instagram,
          },
        },
      );
      expect(profileUpdate.ok(), 'No se pudo preparar el WhatsApp del fixture').toBeTruthy();

      const publicBusiness = await request.get(
        `${env.backendUrl}/api/v1/public/businesses/${encodeURIComponent(env.businessSlug)}`,
      );
      expect(publicBusiness.ok(), 'No se pudo consultar la página pública del fixture').toBeTruthy();
      const business = (await publicBusiness.json()) as {
        id: string;
        branches: Array<{ id: string; name: string }>;
        services: Array<{ id: string; branchId: string }>;
      };

      const forbidden = await request.post(`${env.backendUrl}/api/v1/public/bookings`, {
        data: {
          businessId: business.id,
          branchId: business.branches[0]?.id,
          serviceOfferingId: business.services?.[0]?.id ?? '00000000-0000-0000-0000-000000000000',
          resourceId: '00000000-0000-0000-0000-000000000000',
          date: env.bookingDate,
          startsAt: '09:00',
          customerName: 'E2E WhatsApp manual',
          customerPhone: '1123456789',
        },
      });
      expect(forbidden.status()).toBe(403);

      await page.goto(routes.publicBusiness);
      const whatsappLink = page.locator('a.whatsapp-link');
      await expect(whatsappLink).toBeVisible();
      await expect(whatsappLink).toHaveAttribute('href', `https://wa.me/${whatsapp}`);
      await expect(whatsappLink).toHaveAttribute('target', '_blank');
    } finally {
      await updateBusinessConfiguration(request, fixture, originalConfiguration);
      await request.put(`${env.backendUrl}/api/v1/businesses/${fixture.businessId}/public-profile`, {
        headers: { Authorization: `Bearer ${fixture.token}` },
        data: {
          publicDescription: originalBusiness.publicDescription,
          aboutUs: originalBusiness.aboutUs,
          whatsapp: originalBusiness.whatsapp,
          instagram: originalBusiness.instagram,
        },
      });
    }
  });
});

test.describe('copiar semana', () => {
  test('copia las reservas a la semana siguiente desde la agenda', async ({ page, request }) => {
    test.setTimeout(120_000);
    const fixture = await authenticatedFixture(request);
    const original = await getBusinessConfiguration(request, fixture);
    const source = await createBookingFixture(request, 'CopiarSemana');
    const createdIds: string[] = [];

    try {
      const enabled = await updateBusinessConfiguration(request, fixture, {
        weeklyBookingCopyEnabled: true,
      });
      expect(enabled.ok(), 'No se pudo habilitar copiar semana').toBeTruthy();

      await login(page);
      const form = page.locator('form.booking-filter');
      await page.getByRole('radio', { name: 'Semana' }).click();
      await form.getByLabel('Semana', { exact: true }).fill(materialDate(env.bookingDate));
      await selectMaterialOption(page, form, 'Sucursal', env.branchName);
      await selectMaterialOption(page, form, 'Servicio', env.serviceName);
      await selectMaterialOption(page, form, 'Recurso', env.resourceName);
      await form.getByRole('button', { name: 'Ver reservas' }).click();
      await expect(page.locator('.week-booking-row').filter({ hasText: source.customerName })).toBeVisible();

      await page.getByRole('button', { name: 'Copiar semana', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Copiar semana' })).toBeVisible();
      await dialog.getByLabel('Semana destino', { exact: true }).fill(
        materialDate(addDays(env.bookingDate, 7)),
      );
      const responsePromise = page.waitForResponse(
        (response) => response.url().endsWith('/copy-week') && response.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: 'Copiar semana', exact: true }).click();
      const response = await responsePromise;
      expect(response.ok(), `Falló copiar semana: ${response.status()} ${await response.text()}`).toBeTruthy();
      const result = (await response.json()) as {
        createdCount: number;
        created: Array<{ bookingId: string }>;
      };
      createdIds.push(...result.created.map((item) => item.bookingId));
      expect(result.createdCount).toBeGreaterThanOrEqual(1);

      const repeated = await request.post(
        `${env.backendUrl}/api/v1/businesses/${fixture.businessId}/bookings/copy-week`,
        {
          headers: { Authorization: `Bearer ${fixture.token}` },
          data: {
            sourceWeekStart: startOfWeek(env.bookingDate),
            targetWeekStart: startOfWeek(addDays(env.bookingDate, 7)),
            branchId: undefined,
            resourceId: undefined,
            serviceOfferingId: undefined,
          },
        },
      );
      expect(repeated.ok(), `Falló la repetición de copiar semana: ${await repeated.text()}`).toBeTruthy();
      const repeatedResult = (await repeated.json()) as { createdCount: number; skippedCount: number };
      expect(repeatedResult.createdCount).toBe(0);
      expect(repeatedResult.skippedCount).toBeGreaterThanOrEqual(1);
      await page.locator('.week-day-card').nth(1).click();
      await expect(page.locator('.week-booking-row').filter({ hasText: source.customerName })).toBeVisible();
    } finally {
      await Promise.all(
        [source.id, ...createdIds].map((id) => cancelBooking(request, fixture.token, id)),
      );
      await updateBusinessConfiguration(request, fixture, original);
    }
  });
});

function materialDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

function materialDateWithoutPadding(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${Number(month)}/${Number(day)}/${year}`;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function startOfWeek(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00`);
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

type ResourceFixture = {
  id: string;
  visibleName: string;
  type: string;
  status: string;
  serviceOfferingIds: string[];
  weeklySchedule: Array<{
    day: string;
    timeRanges: Array<{ start: string; end: string }>;
  }>;
  absences: Array<{
    date: string;
    allDay: boolean;
    startsAt?: string | null;
    endsAt?: string | null;
  }>;
};

type ScheduleException = {
  id: string;
  date: string;
  type: string;
  startTime?: string | null;
  endTime?: string | null;
  reason?: string | null;
};

function localIsoDate(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dayOfWeek(isoDate: string): string {
  const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  return days[new Date(`${isoDate}T12:00:00`).getDay()];
}
