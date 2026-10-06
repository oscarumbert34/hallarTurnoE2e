import { APIRequestContext, expect, test } from '@playwright/test';
import {
  authenticatedFixture,
  AuthFixture,
  BusinessConfiguration,
  fixtureTopology,
  FixtureTopology,
  getBusinessConfiguration,
  updateBusinessConfiguration,
} from './support/api';
import { env, uniqueCustomer } from './support/environment';
import { login } from './support/ui';

type Queue = {
  id: string;
  branchId: string;
  status: 'OPEN' | 'CLOSED';
};

type QueueEntry = {
  id: string;
  queueId: string;
  customerName: string;
  status: 'WAITING' | 'CALLED' | 'SERVING' | 'COMPLETED' | 'ABSENT';
};

test.describe.serial('fila virtual', () => {
  let auth: AuthFixture;
  let topology: FixtureTopology;
  let originalConfiguration: BusinessConfiguration;

  test.beforeAll(async ({ request }) => {
    auth = await authenticatedFixture(request);
    topology = await fixtureTopology(request, auth);
    originalConfiguration = await getBusinessConfiguration(request, auth);
    const response = await updateBusinessConfiguration(request, auth, {
      virtualQueueEnabled: true,
    });
    expect(response.ok(), `No se pudo habilitar la fila: ${response.status()}`).toBeTruthy();
    await closeOpenQueue(request);
  });

  test.afterEach(async ({ request }) => {
    await closeOpenQueue(request);
  });

  test.afterAll(async ({ request }) => {
    const response = await updateBusinessConfiguration(request, auth, originalConfiguration);
    expect(response.ok(), `No se pudo restaurar la configuración: ${response.status()}`).toBeTruthy();
  });

  test('el comercio abre la fila, agrega una persona sin teléfono y finaliza su atención', async ({
    page,
  }) => {
    const customer = uniqueCustomer('Fila comercio');
    await login(page);
    await page.goto(`/${env.businessSlug}/admin/fila`);

    await expect(page.getByRole('heading', { name: 'Fila virtual' })).toBeVisible();
    await expect(page.locator('mat-select').getByText(env.branchName, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Abrir fila' }).click();
    await expect(page.getByText('Abierta', { exact: true })).toBeVisible();

    await page.getByLabel('Nombre').fill(customer.name);
    await page.getByRole('button', { name: 'Agregar a la fila' }).click();

    await expect(page.getByText(`Enlace de seguimiento de ${customer.name}`)).toBeVisible();
    const entryCard = page.locator('.entry-card').filter({ hasText: customer.name });
    await expect(entryCard).toContainText('Sin teléfono');
    await expect(entryCard).toContainText('En espera');
    await expect(entryCard.getByRole('button', { name: /Copiar seguimiento/ })).toBeVisible();

    await entryCard.getByRole('button', { name: 'Atender' }).click();
    await expect(entryCard).toContainText('Atendiendo');
    await entryCard.getByRole('button', { name: 'Finalizar' }).click();
    await expect(entryCard).toContainText('Finalizado');
    await expect(entryCard).toHaveClass(/done/);
  });

  test('la persona se suma con datos obligatorios y sigue los cambios de su turno', async ({
    page,
    request,
  }) => {
    const queue = await openQueue(request);
    const customer = uniqueCustomer('Fila pública');
    await page.goto(`/fila/${env.businessSlug}/${topology.branchId}`);

    await expect(page.getByRole('heading', { name: env.branchName })).toBeVisible();
    await page.getByRole('button', { name: 'Unirme a la fila' }).click();
    await expect(page.getByText('Ingresá tu nombre.')).toBeVisible();
    await expect(page.getByText('Ingresá tu teléfono.')).toBeVisible();

    await page.getByLabel('Tu nombre').fill(customer.name);
    await page.getByLabel('Tu teléfono').fill('123');
    await page.getByRole('button', { name: 'Unirme a la fila' }).click();
    await expect(page.getByText('Usá el formato 1124546622.')).toBeVisible();

    await page.getByLabel('Tu teléfono').fill(customer.phone);
    const joinResponse = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith(`/virtual-queues/${topology.branchId}/join`),
    );
    await page.getByRole('button', { name: 'Unirme a la fila' }).click();
    expect((await joinResponse).status()).toBe(201);
    await expect(page).toHaveURL(/\/espera\/[0-9a-f-]+$/);
    await expect(page.getByText('Estás en espera')).toBeVisible();
    await expect(page.getByText('Tu posición puede avanzar')).toBeVisible();
    await expect(page.getByText(/marcarla como ausente y quitarla de la espera/)).toBeVisible();

    const entryId = page.url().split('/').at(-1)!;
    await updateEntryStatus(request, queue.id, entryId, 'SERVING');
    await page.reload();
    await expect(page.getByText('Te están atendiendo')).toBeVisible();

    await updateEntryStatus(request, queue.id, entryId, 'COMPLETED');
    await page.reload();
    await expect(page.getByText('Atención finalizada')).toBeVisible();
  });

  test('cerrar y volver a abrir crea una fila nueva sin recuperar la anterior', async ({ request }) => {
    const first = await openQueue(request);
    const firstCustomer = uniqueCustomer('Fila anterior');
    const entry = await addEntry(request, first.id, firstCustomer.name);
    expect(entry.status).toBe('WAITING');

    await closeQueue(request, topology.branchId);
    const second = await openQueue(request);
    expect(second.id).not.toBe(first.id);

    const entriesResponse = await request.get(
      `${env.backendUrl}/api/v1/virtual-queues/${second.id}/entries`,
      { headers: authHeaders() },
    );
    expect(entriesResponse.ok()).toBeTruthy();
    expect((await entriesResponse.json()) as QueueEntry[]).toEqual([]);
  });

  async function currentQueue(request: APIRequestContext): Promise<Queue | null> {
    const response = await request.get(
      `${env.backendUrl}/api/v1/virtual-queues/branch/${topology.branchId}`,
      { headers: authHeaders() },
    );
    if (response.status() === 404) return null;
    expect(response.ok(), `No se pudo consultar la fila: ${response.status()} ${await response.text()}`).toBeTruthy();
    return response.json() as Promise<Queue>;
  }

  async function openQueue(request: APIRequestContext): Promise<Queue> {
    const response = await request.post(
      `${env.backendUrl}/api/v1/virtual-queues/${topology.branchId}/open`,
      { headers: authHeaders() },
    );
    expect(response.ok(), `No se pudo abrir la fila: ${response.status()} ${await response.text()}`).toBeTruthy();
    return response.json() as Promise<Queue>;
  }

  async function closeQueue(request: APIRequestContext, branchId: string): Promise<void> {
    const response = await request.post(`${env.backendUrl}/api/v1/virtual-queues/${branchId}/close`, {
      headers: authHeaders(),
    });
    expect(response.ok(), `No se pudo cerrar la fila: ${response.status()} ${await response.text()}`).toBeTruthy();
  }

  async function closeOpenQueue(request: APIRequestContext): Promise<void> {
    const queue = await currentQueue(request);
    if (queue?.status === 'OPEN') await closeQueue(request, topology.branchId);
  }

  async function addEntry(
    request: APIRequestContext,
    queueId: string,
    customerName: string,
  ): Promise<QueueEntry> {
    const response = await request.post(`${env.backendUrl}/api/v1/virtual-queues/${queueId}/entries`, {
      headers: authHeaders(),
      data: { customerName },
    });
    expect(response.ok(), `No se pudo agregar a la fila: ${response.status()} ${await response.text()}`).toBeTruthy();
    return response.json() as Promise<QueueEntry>;
  }

  async function updateEntryStatus(
    request: APIRequestContext,
    queueId: string,
    entryId: string,
    status: QueueEntry['status'],
  ): Promise<void> {
    const response = await request.patch(
      `${env.backendUrl}/api/v1/virtual-queues/${queueId}/entries/${entryId}/status`,
      { headers: authHeaders(), data: { status } },
    );
    expect(response.ok(), `No se pudo actualizar el estado: ${response.status()} ${await response.text()}`).toBeTruthy();
  }

  function authHeaders(): { Authorization: string } {
    return { Authorization: `Bearer ${auth.token}` };
  }
});
