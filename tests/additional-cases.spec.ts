import { expect, test } from '@playwright/test';
import {
  cancelBooking,
  createBookingFixture,
  loginThroughApi,
} from './support/api';
import { env, routes, uniqueCustomer } from './support/environment';
import {
  chooseAvailableSlot,
  completeCustomer,
  findBookingAcrossPages,
  fillSearch,
  login,
  showBookingsForDate,
} from './support/ui';

test.describe('seguridad y validaciones', () => {
  test('rechaza credenciales incorrectas sin crear sesión', async ({ page }) => {
    await page.goto(routes.login);
    await page.getByLabel('Email').fill(env.email);
    await page.getByLabel('Contraseña').fill('password-incorrecta-e2e');
    await page.getByRole('button', { name: 'Ingresar' }).click();

    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(page.getByRole('button', { name: 'Ingresar' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Salir', exact: true })).toHaveCount(0);
  });

  test('redirige al login al intentar acceder a reservas sin autenticación', async ({ page }) => {
    await page.goto(routes.bookings);
    await expect(page).toHaveURL(
      new RegExp(`/auth/login\\?returnUrl=%2F${env.businessSlug}%2Fbookings$`),
    );
    await expect(page.getByText('Ingresar', { exact: true }).first()).toBeVisible();
  });

  test('mantiene la sesión al recargar y la elimina al cerrar sesión', async ({ page }) => {
    await login(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Reservas' })).toBeVisible();

    await page.getByRole('button', { name: 'Salir', exact: true }).first().click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await page.goto(routes.bookings);
    await expect(page).toHaveURL(
      new RegExp(`/auth/login\\?returnUrl=%2F${env.businessSlug}%2Fbookings$`),
    );
  });
});

test.describe('formulario de reserva', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(routes.publicBusiness);
    await page.getByRole('button', { name: 'Reservar turno' }).click();
    const result = await fillSearch(page);
    await chooseAvailableSlot(result);
  });

  test('no permite confirmar sin datos obligatorios', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Confirmar turno' })).toBeDisabled();
  });

  test('valida un teléfono con formato incorrecto', async ({ page }) => {
    await page.getByLabel('Nombre y apellido').fill('E2E Teléfono Inválido');
    await page.getByLabel('Teléfono').fill('123');
    await page.getByLabel('Teléfono').blur();

    await expect(page.getByText('Usa el formato 1124546622.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar turno' })).toBeDisabled();
  });

  test('valida el email de un cliente nuevo', async ({ page }) => {
    const customer = uniqueCustomer('EmailInvalido');
    await page.getByLabel('Nombre y apellido').fill(customer.name);
    await page.getByLabel('Teléfono').fill(customer.phone);
    await page.getByLabel('Teléfono').blur();
    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    await expect(email).toBeVisible();
    await email.fill('email-invalido');
    await email.blur();

    await expect(page.getByText('Ingresa un email válido.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar turno' })).toBeDisabled();
  });
});

test.describe('filtros de agenda', () => {
  test('muestra una reserva cancelada al filtrar por estado', async ({ page, request }) => {
    const token = await loginThroughApi(request);
    const booking = await createBookingFixture(request, 'FiltroCancelada');

    try {
      const cancellation = await cancelBooking(request, token, booking.id);
      expect(cancellation.ok(), 'No se pudo cancelar el fixture del filtro').toBeTruthy();
      await login(page);
      await showBookingsForDate(page, 'CANCELLED');
      const row = page.locator('.week-booking-row').filter({ hasText: booking.customerName });
      await expect(row).toContainText('Cancelada');
    } finally {
      await cancelBooking(request, token, booking.id);
    }
  });
});

test.describe('concurrencia de reservas', () => {
  test('sólo permite una reserva cuando dos clientes confirman el mismo turno', async ({
    browser,
    request,
  }) => {
    test.setTimeout(90_000);
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const customerA = uniqueCustomer('ConcurrenteA');
    const customerB = uniqueCustomer('ConcurrenteB');
    const token = await loginThroughApi(request);
    let winningBookingId: string | undefined;

    try {
      const prepare = async (
        page: typeof pageA,
        customer: ReturnType<typeof uniqueCustomer>,
      ): Promise<string> => {
        await page.goto(routes.publicBusiness);
        await page.getByRole('button', { name: 'Reservar turno' }).click();
        const result = await fillSearch(page);
        const slot = await chooseAvailableSlot(result);
        await completeCustomer(page, customer);
        return slot;
      };

      const [slotA, slotB] = await Promise.all([
        prepare(pageA, customerA),
        prepare(pageB, customerB),
      ]);
      expect(slotA, 'Ambos clientes deben seleccionar el mismo horario').toBe(slotB);

      const responseA = pageA.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/public/bookings') &&
          response.request().method() === 'POST',
      );
      const responseB = pageB.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/public/bookings') &&
          response.request().method() === 'POST',
      );

      await Promise.all([
        pageA.getByRole('button', { name: 'Confirmar turno' }).click(),
        pageB.getByRole('button', { name: 'Confirmar turno' }).click(),
      ]);
      const responses = await Promise.all([responseA, responseB]);
      const statuses = responses.map((response) => response.status()).sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      const winnerIndex = responses.findIndex((response) => response.ok());
      const loserPage = winnerIndex === 0 ? pageB : pageA;
      const winnerCustomer = winnerIndex === 0 ? customerA : customerB;
      const loserCustomer = winnerIndex === 0 ? customerB : customerA;
      winningBookingId = ((await responses[winnerIndex].json()) as { id: string }).id;

      await expect(loserPage.getByText('Ese turno ya fue reservado. Actualizamos la disponibilidad para que elijas otro.')).toBeVisible();

      const agendaPage = await contextA.newPage();
      await login(agendaPage);
      await showBookingsForDate(agendaPage);
      await expect(await findBookingAcrossPages(agendaPage, winnerCustomer.name)).toHaveCount(1);
      await expect(loserPage.getByText(loserCustomer.name)).toHaveCount(0);
    } finally {
      if (winningBookingId) {
        const cleanup = await cancelBooking(request, token, winningBookingId);
        expect(cleanup.ok(), 'No se pudo cancelar la reserva ganadora concurrente').toBeTruthy();
      }
      await Promise.all([contextA.close(), contextB.close()]);
    }
  });
});

test.describe('actualización de disponibilidad', () => {
  test('cada reserva creada deja de ofrecer inmediatamente su horario', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const token = await loginThroughApi(request);
    const bookingIds: string[] = [];
    const reservedTimes: string[] = [];
    const reservationsToCreate = 3;

    const openAvailability = async () => {
      await page.goto(routes.publicBusiness);
      await page.getByRole('button', { name: 'Reservar turno' }).click();
      return fillSearch(page);
    };

    try {
      for (let index = 1; index <= reservationsToCreate; index += 1) {
        const result = await openAvailability();

        for (const unavailableTime of reservedTimes) {
          await expect(
            result.locator('.slots').getByRole('button', {
              name: unavailableTime,
              exact: true,
            }),
          ).toHaveCount(0);
        }

        const selectedTime = await chooseAvailableSlot(result);
        const customer = uniqueCustomer(`Disponibilidad${index}`);
        await completeCustomer(page, customer);
        const bookingResponsePromise = page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/v1/public/bookings') &&
            response.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Confirmar turno' }).click();
        const bookingResponse = await bookingResponsePromise;
        expect(bookingResponse.status()).toBe(201);
        const booking = (await bookingResponse.json()) as { id: string };
        bookingIds.push(booking.id);
        reservedTimes.push(selectedTime);
        await expect(page.getByRole('status')).toContainText(/Reserva (confirmada|creada)/);

        const refreshedResult = await openAvailability();
        await expect(
          refreshedResult.locator('.slots').getByRole('button', {
            name: selectedTime,
            exact: true,
          }),
        ).toHaveCount(0);
      }

      expect(new Set(reservedTimes).size).toBe(reservationsToCreate);
    } finally {
      await Promise.all(
        bookingIds.map(async (bookingId) => {
          const cleanup = await cancelBooking(request, token, bookingId);
          expect(cleanup.ok(), `No se pudo cancelar la reserva E2E ${bookingId}`).toBeTruthy();
        }),
      );
    }
  });
});
