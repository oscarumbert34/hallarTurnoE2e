import { expect, test } from '@playwright/test';
import {
  authenticatedFixture,
  availableSlots,
  cancelBooking,
  createBookingAt,
  fixtureTopology,
  getBusinessConfiguration,
  updateBusinessConfiguration,
} from './support/api';
import { env } from './support/environment';

test.describe('acciones públicas del turno', () => {
  test('el cliente confirma su turno con un token y no puede reutilizarlo', async ({ page, request }) => {
    const fixture = await authenticatedFixture(request);
    const topology = await fixtureTopology(request, fixture);
    const original = await getBusinessConfiguration(request, fixture);
    let bookingId: string | undefined;
    try {
      expect((await updateBusinessConfiguration(request, fixture, { appointmentConfirmationEnabled: true })).ok()).toBeTruthy();
      const [slot] = await availableSlots(request, topology);
      const booking = await createBookingAt(request, topology, slot, 'Confirmacion', { token: fixture.token });
      bookingId = booking.id;
      const token = await issueToken(request, fixture.token, booking.id);

      await page.goto(`/turno/${token}`);
      await expect(page.getByRole('button', { name: 'Confirmar turno' })).toBeVisible();
      await page.getByRole('button', { name: 'Confirmar turno' }).click();
      await expect(page.getByRole('heading', { name: 'Tu turno fue confirmado' })).toBeVisible();
      await page.reload();
      await expect(page.getByText('Este turno ya fue gestionado.')).toBeVisible();
    } finally {
      if (bookingId) await cancelBooking(request, fixture.token, bookingId);
      await updateBusinessConfiguration(request, fixture, original);
    }
  });

  test('el cliente cancela su turno con un token y libera el horario', async ({ page, request }) => {
    const fixture = await authenticatedFixture(request);
    const topology = await fixtureTopology(request, fixture);
    const original = await getBusinessConfiguration(request, fixture);
    let bookingId: string | undefined;
    try {
      expect((await updateBusinessConfiguration(request, fixture, { appointmentConfirmationEnabled: true })).ok()).toBeTruthy();
      const [slot] = await availableSlots(request, topology);
      const booking = await createBookingAt(request, topology, slot, 'CancelacionCliente', { token: fixture.token });
      bookingId = booking.id;
      const token = await issueToken(request, fixture.token, booking.id);

      await page.goto(`/turno/${token}`);
      await page.getByRole('button', { name: 'Cancelar turno' }).click();
      await page.getByRole('button', { name: 'Sí, cancelar' }).click();
      await expect(page.getByRole('heading', { name: 'Tu turno fue cancelado' })).toBeVisible();
      const remaining = await availableSlots(request, topology);
      expect(remaining.map((item) => item.startsAt.slice(0, 5))).toContain(slot.startsAt.slice(0, 5));
      bookingId = undefined;
    } finally {
      if (bookingId) await cancelBooking(request, fixture.token, bookingId);
      await updateBusinessConfiguration(request, fixture, original);
    }
  });

  test('muestra un mensaje específico para un token inválido', async ({ page }) => {
    await page.goto(`/turno/${'x'.repeat(43)}`);
    await expect(page.getByRole('heading', { name: 'No pudimos gestionar tu turno' })).toBeVisible();
    await expect(page.getByText(/enlace no es válido/i)).toBeVisible();
  });
});

async function issueToken(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  bookingId: string,
): Promise<string> {
  const response = await request.post(
    `${env.backendUrl}/api/v1/testing/bookings/${bookingId}/action-token`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(response.ok(), `No se pudo emitir token E2E: ${response.status()} ${await response.text()}`).toBeTruthy();
  return ((await response.json()) as { token: string }).token;
}
