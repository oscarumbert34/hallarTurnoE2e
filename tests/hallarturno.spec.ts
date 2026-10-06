import { expect, test } from '@playwright/test';
import { cancelBooking, loginThroughApi } from './support/api';
import { env, routes, uniqueCustomer } from './support/environment';
import {
  chooseAvailableSlot,
  completeCustomer,
  findBookingAcrossPages,
  fillSearch,
  login,
  showBookingsForDate,
} from './support/ui';

test.describe('flujos principales de HallarTurno', () => {
  test('inicio de sesión del negocio', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(new RegExp(`/${env.businessSlug}/bookings$`));
    await expect(page.getByRole('heading', { name: 'Reservas' })).toBeVisible();

    await page.getByRole('link', { name: 'Panel', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Panel de negocio' })).toBeVisible();
    await expect(page.getByText(env.branchName, { exact: true }).first()).toBeVisible();
  });

  test('creación y cancelación manual de un turno', async ({ page, request }) => {
    const customer = uniqueCustomer('Manual');
    let bookingId: string | undefined;
    const token = await loginThroughApi(request);

    try {
      await login(page);
      await page.getByRole('link', { name: 'Busqueda', exact: true }).first().click();
      const result = await fillSearch(page);
      await chooseAvailableSlot(result);
      await completeCustomer(page, customer);

      const bookingResponsePromise = page.waitForResponse(
        (response) => response.url().endsWith('/api/v1/bookings') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Confirmar turno' }).click();
      const bookingResponse = await bookingResponsePromise;
      expect(bookingResponse.ok(), await bookingResponse.text()).toBeTruthy();
      bookingId = ((await bookingResponse.json()) as { id: string }).id;
      await expect(page.getByRole('status')).toContainText(/Reserva (confirmada|creada)/);

      await showBookingsForDate(page);
      const row = await findBookingAcrossPages(page, customer.name);
      await expect(row).toBeVisible();
      await row.click();
      page.once('dialog', (dialog) => dialog.accept());
      const cancelResponsePromise = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/bookings/${bookingId}/cancel`) &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Cancelar reserva' }).click();
      const cancelResponse = await cancelResponsePromise;
      expect(cancelResponse.ok(), await cancelResponse.text()).toBeTruthy();
      bookingId = undefined;
      await showBookingsForDate(page, 'ALL');
      const cancelledRow = page.locator('.week-booking-row').filter({ hasText: customer.name });
      await expect(cancelledRow).toContainText('Cancelada');
    } finally {
      if (bookingId) await cancelBooking(request, token, bookingId);
    }
  });

  test('reserva desde la página pública y visualización en agenda', async ({ page, request }) => {
    const customer = uniqueCustomer('Publica');
    let bookingId: string | undefined;
    const token = await loginThroughApi(request);

    try {
      await page.goto(routes.publicBusiness);
      await expect(page.getByRole('heading', { name: env.businessName })).toBeVisible();
      await page.getByRole('button', { name: 'Reservar turno' }).click();
      await expect(page).toHaveURL(
        new RegExp(`/${env.businessSlug}/search(?:\\?.*)?$`),
      );
      const result = await fillSearch(page);
      await chooseAvailableSlot(result);
      await completeCustomer(page, customer);

      const bookingResponsePromise = page.waitForResponse(
        (response) => response.url().endsWith('/api/v1/public/bookings') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Confirmar turno' }).click();
      const bookingResponse = await bookingResponsePromise;
      expect(bookingResponse.ok(), await bookingResponse.text()).toBeTruthy();
      bookingId = ((await bookingResponse.json()) as { id: string }).id;
      await expect(page.getByRole('status')).toContainText(/Reserva (confirmada|creada)/);

      await login(page);
      await showBookingsForDate(page);
      await expect(await findBookingAcrossPages(page, customer.name)).toBeVisible();
    } finally {
      if (bookingId) {
        const cleanup = await cancelBooking(request, token, bookingId);
        expect(cleanup.ok(), `No se pudo cancelar el turno E2E ${bookingId}`).toBeTruthy();
      }
    }
  });
});
