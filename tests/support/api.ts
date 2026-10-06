import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { env } from './environment';
import { uniqueCustomer } from './environment';

type LoginResponse = {
  token?: string;
  accessToken?: string;
  businessId?: string;
  businessSlug?: string;
};

export type AuthFixture = {
  token: string;
  businessId: string;
};

export type FixtureTopology = {
  businessId: string;
  branchId: string;
  serviceId: string;
  resourceId: string;
};

export type AvailableSlot = { startsAt: string; resourceId: string };

export type BusinessConfiguration = {
  weeklyBookingCopyEnabled: boolean;
  depositEnabled: boolean;
  appointmentConfirmationEnabled: boolean;
  internalBookingCreation: boolean;
};

export async function authenticatedFixture(request: APIRequestContext): Promise<AuthFixture> {
  const response = await request.post(`${env.backendUrl}/api/v1/auth/login`, {
    data: { email: env.email, password: env.password },
  });
  expect(response.ok(), `El login API falló: ${response.status()} ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as LoginResponse;
  const token = body.token ?? body.accessToken;
  expect(token, 'El login API no devolvió token').toBeTruthy();
  expect(body.businessId, 'El login API no devolvió businessId').toBeTruthy();
  expect(body.businessSlug, 'El login API no devolvió businessSlug').toBe(env.businessSlug);
  return { token: token!, businessId: body.businessId! };
}

export async function loginThroughApi(request: APIRequestContext): Promise<string> {
  return (await authenticatedFixture(request)).token;
}

export async function fixtureTopology(
  request: APIRequestContext,
  fixture?: AuthFixture,
): Promise<FixtureTopology> {
  const auth = fixture ?? (await authenticatedFixture(request));
  const headers = { Authorization: `Bearer ${auth.token}` };
  const publicResponse = await request.get(
    `${env.backendUrl}/api/v1/public/businesses/${encodeURIComponent(env.businessSlug)}`,
  );
  expect(publicResponse.ok(), 'No se pudo obtener el negocio público E2E').toBeTruthy();
  const business = (await publicResponse.json()) as {
    id: string;
    branches: Array<{ id: string; name: string }>;
    services: Array<{ id: string; name: string; branchId: string }>;
  };
  const branch = business.branches.find((item) => item.name === env.branchName);
  expect(branch, `No existe la sucursal ${env.branchName}`).toBeTruthy();
  const servicesResponse = await request.get(
    `${env.backendUrl}/api/v1/businesses/${business.id}/service-offerings`,
  );
  expect(servicesResponse.ok(), 'No se pudieron obtener los servicios E2E').toBeTruthy();
  const services = (await servicesResponse.json()) as Array<{
    id: string;
    name: string;
    branchId: string;
  }>;
  const service = services.find(
    (item) => item.name === env.serviceName && item.branchId === branch!.id,
  );
  expect(service, `No existe el servicio ${env.serviceName}`).toBeTruthy();
  const resourcesResponse = await request.get(
    `${env.backendUrl}/api/v1/branches/${branch!.id}/resources`,
    { headers },
  );
  expect(resourcesResponse.ok(), 'No se pudieron obtener los recursos E2E').toBeTruthy();
  const resources = (await resourcesResponse.json()) as Array<{
    id: string;
    visibleName: string;
  }>;
  const resource = resources.find((item) => item.visibleName === env.resourceName);
  expect(resource, `No existe el recurso ${env.resourceName}`).toBeTruthy();
  return {
    businessId: business.id,
    branchId: branch!.id,
    serviceId: service!.id,
    resourceId: resource!.id,
  };
}

export async function availableSlots(
  request: APIRequestContext,
  topology: FixtureTopology,
  date = env.bookingDate,
): Promise<AvailableSlot[]> {
  const response = await request.get(`${env.backendUrl}/api/v1/public/availability`, {
    params: {
      date,
      service: env.serviceName,
      startsFrom: '00:00',
      startsTo: '23:30',
      businessId: topology.businessId,
      branchId: topology.branchId,
      offset: 0,
      limit: 20,
      maxSlotsPerService: 50,
    },
  });
  expect(response.ok(), `Falló disponibilidad: ${response.status()} ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as {
    results: Array<{ branches: Array<{ services: Array<{ id: string; slots: AvailableSlot[] }> }> }>;
  };
  return body.results
    .flatMap((result) => result.branches)
    .flatMap((branch) => branch.services)
    .filter((service) => service.id === topology.serviceId)
    .flatMap((service) => service.slots)
    .filter((slot) => slot.resourceId === topology.resourceId);
}

export async function createBookingAt(
  request: APIRequestContext,
  topology: FixtureTopology,
  slot: AvailableSlot,
  prefix: string,
  options: { token?: string; depositPaid?: boolean; skipCustomerContact?: boolean } = {},
): Promise<{ id: string; customerName: string; customerPhone: string; startsAt: string; depositStatus: string }> {
  const customer = uniqueCustomer(prefix);
  const endpoint = options.token ? '/api/v1/bookings' : '/api/v1/public/bookings';
  const response = await request.post(`${env.backendUrl}${endpoint}`, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
    data: {
      branchId: topology.branchId,
      serviceOfferingId: topology.serviceId,
      resourceId: slot.resourceId,
      date: env.bookingDate,
      startsAt: slot.startsAt.slice(0, 5),
      customerName: customer.name,
      customerPhone: customer.phone,
      customerEmail: customer.email,
      skipCustomerContact: options.skipCustomerContact,
      depositPaid: options.depositPaid,
    },
  });
  expect(response.ok(), `No se pudo crear la reserva: ${response.status()} ${await response.text()}`).toBeTruthy();
  const booking = (await response.json()) as {
    id: string;
    customerName: string;
    customerPhone: string;
    startsAt: string;
    depositStatus: string;
  };
  return { ...booking, customerName: customer.name, customerPhone: customer.phone };
}

export async function getBusinessConfiguration(
  request: APIRequestContext,
  fixture: AuthFixture,
): Promise<BusinessConfiguration> {
  const response = await request.get(
    `${env.backendUrl}/api/v1/businesses/${fixture.businessId}/configuration`,
    { headers: { Authorization: `Bearer ${fixture.token}` } },
  );
  expect(response.ok(), `No se pudo leer la configuración: ${response.status()}`).toBeTruthy();
  return response.json() as Promise<BusinessConfiguration>;
}

export async function updateBusinessConfiguration(
  request: APIRequestContext,
  fixture: AuthFixture,
  configuration: Partial<BusinessConfiguration>,
): Promise<APIResponse> {
  const current = await getBusinessConfiguration(request, fixture);
  return request.put(
    `${env.backendUrl}/api/v1/businesses/${fixture.businessId}/configuration`,
    {
      headers: { Authorization: `Bearer ${fixture.token}` },
      data: { ...current, ...configuration },
    },
  );
}

export async function cancelBooking(
  request: APIRequestContext,
  token: string,
  bookingId: string,
): Promise<APIResponse> {
  return request.post(`${env.backendUrl}/api/v1/bookings/${bookingId}/cancel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function createBookingFixture(
  request: APIRequestContext,
  prefix: string,
): Promise<{ id: string; customerName: string }> {
  const businessResponse = await request.get(
    `${env.backendUrl}/api/v1/public/businesses/${encodeURIComponent(env.businessSlug)}`,
  );
  expect(businessResponse.ok(), 'No se pudo obtener el negocio E2E').toBeTruthy();
  const business = (await businessResponse.json()) as {
    id: string;
    branches: Array<{ id: string; name: string }>;
  };
  const branch = business.branches.find((item) => item.name === env.branchName);
  expect(branch, `No existe la sucursal ${env.branchName}`).toBeTruthy();

  const availabilityResponse = await request.get(
    `${env.backendUrl}/api/v1/public/availability`,
    {
      params: {
        date: env.bookingDate,
        service: env.serviceName,
        startsFrom: '00:00',
        startsTo: '23:30',
        businessId: business.id,
        branchId: branch!.id,
        offset: 0,
        limit: 10,
        maxSlotsPerService: 10,
      },
    },
  );
  expect(availabilityResponse.ok(), 'No se pudo consultar disponibilidad E2E').toBeTruthy();
  const availability = (await availabilityResponse.json()) as {
    results: Array<{
      branches: Array<{
        services: Array<{
          id: string;
          slots: Array<{ startsAt: string; resourceId: string }>;
        }>;
      }>;
    }>;
  };
  const service = availability.results
    .flatMap((result) => result.branches)
    .flatMap((item) => item.services)
    .find((item) => item.id && item.slots.length);
  const slot = service?.slots[0];
  expect(service && slot, 'No hay un horario disponible para crear el fixture').toBeTruthy();
  const customer = uniqueCustomer(prefix);

  const bookingResponse = await request.post(`${env.backendUrl}/api/v1/public/bookings`, {
    data: {
      businessId: business.id,
      branchId: branch!.id,
      serviceOfferingId: service!.id,
      resourceId: slot!.resourceId,
      date: env.bookingDate,
      startsAt: slot!.startsAt.slice(0, 5),
      customerName: customer.name,
      customerPhone: customer.phone,
      customerEmail: customer.email,
    },
  });
  expect(
    bookingResponse.ok(),
    `No se pudo crear el fixture: ${bookingResponse.status()} ${await bookingResponse.text()}`,
  ).toBeTruthy();
  const booking = (await bookingResponse.json()) as { id: string };
  return { id: booking.id, customerName: customer.name };
}
