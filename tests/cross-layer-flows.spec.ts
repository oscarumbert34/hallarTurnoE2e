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
import { env, routes } from './support/environment';

const authorization = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('flujos integrales pendientes', () => {
  test('reprograma una reserva, libera el horario anterior y ocupa el nuevo', async ({ request }) => {
    const fixture = await authenticatedFixture(request);
    const topology = await fixtureTopology(request, fixture);
    const slots = await availableSlots(request, topology);
    expect(slots.length, 'Se necesitan dos horarios libres para reprogramar').toBeGreaterThanOrEqual(2);
    const booking = await createBookingAt(request, topology, slots[0], 'Reprogramar', {
      token: fixture.token,
    });

    try {
      const response = await request.put(
        `${env.backendUrl}/api/v1/bookings/${booking.id}/reschedule`,
        {
          headers: authorization(fixture.token),
          data: {
            date: env.bookingDate,
            startTime: slots[1].startsAt.slice(0, 5),
            resourceId: topology.resourceId,
          },
        },
      );
      expect(response.ok(), `No se pudo reprogramar: ${await response.text()}`).toBeTruthy();
      await response.json();

      const remaining = await availableSlots(request, topology);
      const times = remaining.map((slot) => slot.startsAt.slice(0, 5));
      expect(times).toContain(slots[0].startsAt.slice(0, 5));
      expect(times).not.toContain(slots[1].startsAt.slice(0, 5));
    } finally {
      await cancelBooking(request, fixture.token, booking.id);
    }
  });

  test('registra una seña pendiente, permite marcarla pagada y la persiste', async ({ request }) => {
    const fixture = await authenticatedFixture(request);
    const topology = await fixtureTopology(request, fixture);
    const original = await getBusinessConfiguration(request, fixture);
    let bookingId: string | undefined;
    try {
      expect((await updateBusinessConfiguration(request, fixture, { depositEnabled: true })).ok()).toBeTruthy();
      const [slot] = await availableSlots(request, topology);
      const booking = await createBookingAt(request, topology, slot, 'Sena', { token: fixture.token });
      bookingId = booking.id;
      expect(booking.depositStatus).toBe('PENDING');

      const update = await request.patch(
        `${env.backendUrl}/api/v1/bookings/${booking.id}/deposit-status`,
        { headers: authorization(fixture.token), data: { depositStatus: 'PAID' } },
      );
      expect(update.ok(), await update.text()).toBeTruthy();
      expect(((await update.json()) as { depositStatus: string }).depositStatus).toBe('PAID');

      const list = await request.get(
        `${env.backendUrl}/api/v1/businesses/${fixture.businessId}/bookings`,
        { headers: authorization(fixture.token), params: { date: env.bookingDate, size: 50 } },
      );
      const body = (await list.json()) as { results: Array<{ id: string; depositStatus: string }> };
      expect(body.results.find((item) => item.id === booking.id)?.depositStatus).toBe('PAID');
    } finally {
      if (bookingId) await cancelBooking(request, fixture.token, bookingId);
      await updateBusinessConfiguration(request, fixture, original);
    }
  });

  test('una excepción de sucursal cerrada elimina la disponibilidad y al quitarla la recupera', async ({ request }) => {
    const fixture = await authenticatedFixture(request);
    const topology = await fixtureTopology(request, fixture);
    const headers = authorization(fixture.token);
    const current = await request.get(
      `${env.backendUrl}/api/v1/branches/${topology.branchId}/schedule-exceptions`, { headers },
    );
    const existing = ((await current.json()) as Array<ScheduleException>).find((item) => item.date === env.bookingDate);
    let createdId: string | undefined;
    try {
      const endpoint = existing
        ? `${env.backendUrl}/api/v1/branches/${topology.branchId}/schedule-exceptions/${existing.id}`
        : `${env.backendUrl}/api/v1/branches/${topology.branchId}/schedule-exceptions`;
      const response = await request.fetch(endpoint, {
        method: existing ? 'PUT' : 'POST', headers, data: { date: env.bookingDate, type: 'CLOSED', reason: 'E2E' },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      if (!existing) createdId = ((await response.json()) as { id: string }).id;
      expect(await availableSlots(request, topology)).toHaveLength(0);
    } finally {
      if (existing) {
        await request.put(`${env.backendUrl}/api/v1/branches/${topology.branchId}/schedule-exceptions/${existing.id}`, {
          headers, data: exceptionPayload(existing),
        });
      } else if (createdId) {
        await request.delete(`${env.backendUrl}/api/v1/branches/${topology.branchId}/schedule-exceptions/${createdId}`, { headers });
      }
    }
    expect((await availableSlots(request, topology)).length).toBeGreaterThan(0);
  });

  test('una ausencia de recurso elimina sus horarios y al quitarla los recupera', async ({ request }) => {
    const fixture = await authenticatedFixture(request);
    const topology = await fixtureTopology(request, fixture);
    const headers = authorization(fixture.token);
    const response = await request.get(`${env.backendUrl}/api/v1/resources/${topology.resourceId}`, { headers });
    const resource = (await response.json()) as Resource;
    try {
      const update = await request.put(`${env.backendUrl}/api/v1/resources/${resource.id}`, {
        headers,
        data: resourcePayload(resource, [...resource.absences, { date: env.bookingDate, allDay: true }]),
      });
      expect(update.ok(), await update.text()).toBeTruthy();
      expect(await availableSlots(request, topology)).toHaveLength(0);
    } finally {
      await request.put(`${env.backendUrl}/api/v1/resources/${resource.id}`, {
        headers, data: resourcePayload(resource, resource.absences),
      });
    }
    expect((await availableSlots(request, topology)).length).toBeGreaterThan(0);
  });

  test('crea, edita y elimina un negocio con sucursal, servicio y recurso', async ({ request }) => {
    test.setTimeout(120_000);
    const fixture = await authenticatedFixture(request);
    const headers = authorization(fixture.token);
    const suffix = `${Date.now()}`;
    let businessId: string | undefined;
    try {
      const businessResponse = await request.post(`${env.backendUrl}/api/v1/businesses`, {
        headers,
        data: { name: `E2E Alta ${suffix}`, category: 'OTHERS', shortDescription: 'Alta integral E2E', contactEmail: `alta-${suffix}@example.test` },
      });
      expect(businessResponse.status(), await businessResponse.text()).toBe(201);
      businessId = ((await businessResponse.json()) as { id: string }).id;
      const schedule = weekSchedule('09:00', '18:00');
      const branchResponse = await request.post(`${env.backendUrl}/api/v1/businesses/${businessId}/branches`, {
        headers,
        data: { name: `Sucursal ${suffix}`, address: 'Calle E2E 123', locality: 'Buenos Aires', province: 'Buenos Aires', country: 'Argentina', latitude: -34.6, longitude: -58.45, zoneId: 'America/Argentina/Buenos_Aires', status: 'ACTIVE', weeklySchedule: schedule },
      });
      expect(branchResponse.status(), await branchResponse.text()).toBe(201);
      const branch = (await branchResponse.json()) as { id: string };
      const serviceResponse = await request.post(`${env.backendUrl}/api/v1/businesses/${businessId}/service-offerings`, {
        headers,
        data: { name: `Servicio ${suffix}`, description: 'Inicial', durationMinutes: 30, price: 1000, currency: 'ARS', status: 'ACTIVE', branchId: branch.id },
      });
      expect(serviceResponse.status(), await serviceResponse.text()).toBe(201);
      const service = (await serviceResponse.json()) as { id: string };
      const resourceResponse = await request.post(`${env.backendUrl}/api/v1/branches/${branch.id}/resources`, {
        headers,
        data: { visibleName: `Recurso ${suffix}`, type: 'EMPLOYEE', status: 'ACTIVE', serviceOfferingIds: [service.id], weeklySchedule: schedule, absences: [] },
      });
      expect(resourceResponse.status(), await resourceResponse.text()).toBe(201);
      const resource = (await resourceResponse.json()) as { id: string };

      expect((await request.put(`${env.backendUrl}/api/v1/service-offerings/${service.id}`, {
        headers, data: { name: `Servicio editado ${suffix}`, description: 'Editado', durationMinutes: 45, price: 1500, currency: 'ARS', status: 'ACTIVE', branchId: branch.id },
      })).ok()).toBeTruthy();
      expect((await request.delete(`${env.backendUrl}/api/v1/resources/${resource.id}`, { headers })).ok()).toBeTruthy();
      expect((await request.delete(`${env.backendUrl}/api/v1/service-offerings/${service.id}`, { headers })).ok()).toBeTruthy();
      expect((await request.delete(`${env.backendUrl}/api/v1/branches/${branch.id}`, { headers })).ok()).toBeTruthy();
    } finally {
      if (businessId) await request.delete(`${env.backendUrl}/api/v1/businesses/${businessId}`, { headers });
    }
  });

  test('persiste la configuración del negocio desde la API usada por el panel', async ({ request }) => {
    const fixture = await authenticatedFixture(request);
    const original = await getBusinessConfiguration(request, fixture);
    try {
      const expected = {
        weeklyBookingCopyEnabled: !original.weeklyBookingCopyEnabled,
        depositEnabled: !original.depositEnabled,
        appointmentConfirmationEnabled: !original.appointmentConfirmationEnabled,
        internalBookingCreation: !original.internalBookingCreation,
      };
      expect((await updateBusinessConfiguration(request, fixture, expected)).ok()).toBeTruthy();
      expect(await getBusinessConfiguration(request, fixture)).toMatchObject(expected);
    } finally {
      await updateBusinessConfiguration(request, fixture, original);
    }
  });

  test('refleja los cambios del perfil en la página pública', async ({ page, request }) => {
    const fixture = await authenticatedFixture(request);
    const headers = authorization(fixture.token);
    const current = await request.get(`${env.backendUrl}/api/v1/businesses/${fixture.businessId}`, { headers });
    const original = (await current.json()) as PublicProfile;
    const marker = `Descripción pública E2E ${Date.now()}`;
    try {
      const update = await request.put(`${env.backendUrl}/api/v1/businesses/${fixture.businessId}/public-profile`, {
        headers, data: { publicDescription: marker, aboutUs: original.aboutUs, whatsapp: original.whatsapp, instagram: original.instagram },
      });
      expect(update.ok(), await update.text()).toBeTruthy();
      await page.goto(routes.publicBusiness);
      await expect(page.getByText(marker, { exact: true })).toBeVisible();
    } finally {
      await request.put(`${env.backendUrl}/api/v1/businesses/${fixture.businessId}/public-profile`, {
        headers, data: { publicDescription: original.publicDescription, aboutUs: original.aboutUs, whatsapp: original.whatsapp, instagram: original.instagram },
      });
    }
  });

  test('filtra reservas por sucursal, servicio y recurso', async ({ request }) => {
    const fixture = await authenticatedFixture(request);
    const topology = await fixtureTopology(request, fixture);
    const [slot] = await availableSlots(request, topology);
    const booking = await createBookingAt(request, topology, slot, 'Filtros', { token: fixture.token });
    try {
      const response = await request.get(`${env.backendUrl}/api/v1/businesses/${fixture.businessId}/bookings`, {
        headers: authorization(fixture.token),
        params: { date: env.bookingDate, branchId: topology.branchId, serviceOfferingId: topology.serviceId, resourceId: topology.resourceId, size: 50 },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      const body = (await response.json()) as { results: Array<{ id: string }> };
      expect(body.results.some((item) => item.id === booking.id)).toBeTruthy();
    } finally {
      await cancelBooking(request, fixture.token, booking.id);
    }
  });

  test('reutiliza el contacto del cliente y permite omitir su guardado', async ({ request }) => {
    const fixture = await authenticatedFixture(request);
    const topology = await fixtureTopology(request, fixture);
    const slots = await availableSlots(request, topology);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    const saved = await createBookingAt(request, topology, slots[0], 'Contacto', { token: fixture.token });
    const skipped = await createBookingAt(request, topology, slots[1], 'SinContacto', { token: fixture.token, skipCustomerContact: true });
    try {
      const found = await request.get(`${env.backendUrl}/api/v1/businesses/${fixture.businessId}/customer-contacts/search`, {
        headers: authorization(fixture.token), params: { phone: saved.customerPhone },
      });
      expect(found.ok(), await found.text()).toBeTruthy();
      expect(((await found.json()) as { emailRequired: boolean }).emailRequired).toBeFalsy();
      const omitted = await request.get(`${env.backendUrl}/api/v1/businesses/${fixture.businessId}/customer-contacts/search`, {
        headers: authorization(fixture.token), params: { phone: skipped.customerPhone },
      });
      expect(((await omitted.json()) as { emailRequired: boolean }).emailRequired).toBeTruthy();
    } finally {
      await Promise.all([saved.id, skipped.id].map((id) => cancelBooking(request, fixture.token, id)));
    }
  });

  test('maneja slug inexistente y acceso protegido sin sesión', async ({ page, request }) => {
    const missing = await request.get(`${env.backendUrl}/api/v1/public/businesses/no-existe-e2e-${Date.now()}`);
    expect(missing.status()).toBe(404);
    const protectedResponse = await request.get(`${env.backendUrl}/api/v1/businesses/00000000-0000-0000-0000-000000000000/configuration`);
    expect(protectedResponse.status()).toBe(401);
    await page.goto(`/business/no-existe-e2e-${Date.now()}`);
    await expect(page.getByText(/no (encontramos|existe)|no pudo|intentá/i).first()).toBeVisible();
  });

  test('la landing para negocios expone su CTA de contacto seguro', async ({ page }) => {
    await page.goto('/para-negocios');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const cta = page.getByRole('link', { name: /probar HallarTurno/i }).first();
    await expect(cta).toHaveAttribute('href', /^https:\/\/wa\.me\//);
    await expect(cta).toHaveAttribute('target', '_blank');
  });
});

type ScheduleException = { id: string; date: string; type: string; startTime?: string | null; endTime?: string | null; reason?: string | null };
type Resource = { id: string; visibleName: string; type: string; status: string; serviceOfferingIds: string[]; weeklySchedule: unknown[]; absences: unknown[] };
type PublicProfile = { publicDescription?: string | null; aboutUs?: string | null; whatsapp?: string | null; instagram?: string | null };

function exceptionPayload(value: ScheduleException) {
  return { date: value.date, type: value.type, startTime: value.startTime, endTime: value.endTime, reason: value.reason };
}

function resourcePayload(resource: Resource, absences: unknown[]) {
  return { visibleName: resource.visibleName, type: resource.type, status: resource.status, serviceOfferingIds: resource.serviceOfferingIds, weeklySchedule: resource.weeklySchedule, absences };
}

function weekSchedule(start: string, end: string) {
  return ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
    .map((day) => ({ day, timeRanges: [{ start, end }] }));
}
