import { APIRequestContext, expect, test } from '@playwright/test';
import { env } from './support/environment';
import { authenticatedFixture } from './support/api';
import { login } from './support/ui';

type OwnerFixture = {
  businessId: string;
  businessName: string;
  email: string;
  password: string;
  token: string;
};

test.describe('administración restringida de usuarios de comercios', () => {
  test('el administrador configurado puede abrir la pantalla y listar comercios', async ({
    page,
    request,
  }) => {
    const admin = await authenticatedFixture(request);
    const access = await request.get(`${env.backendUrl}/api/v1/platform-admin/access`, {
      headers: authorization(admin.token),
    });
    expect(access.ok(), await access.text()).toBeTruthy();
    expect(await access.json()).toEqual({ allowed: true });

    await login(page);
    await page.goto('/platform-admin');

    await expect(page).toHaveURL(/\/platform-admin$/);
    await expect(page.getByRole('heading', { name: 'Usuarios de comercios' })).toBeVisible();
    await expect(page.getByText(env.businessName, { exact: true })).toBeVisible();
  });

  test('un propietario no configurado no puede acceder por API ni por URL directa', async ({
    page,
    request,
  }) => {
    const owner = await createOwnerAndBusiness(request, 'SinPermiso');

    try {
      const response = await request.get(`${env.backendUrl}/api/v1/platform-admin/businesses`, {
        headers: authorization(owner.token),
      });
      expect(response.status()).toBe(403);

      await page.goto('/auth/login');
      await page.getByLabel('Email').fill(owner.email);
      await page.getByLabel('Contraseña').fill(owner.password);
      await page.getByRole('button', { name: 'Ingresar' }).click();
      await page.goto('/platform-admin');

      await expect(page).not.toHaveURL(/\/platform-admin$/);
      await expect(page.getByRole('heading', { name: 'Usuarios de comercios' })).toHaveCount(0);
    } finally {
      await deleteBusiness(request, owner.businessId, owner.token);
    }
  });

  test('modifica el email de inicio de sesión del propietario', async ({ page, request }) => {
    const owner = await createOwnerAndBusiness(request, 'CambioEmail');
    const updatedEmail = owner.email.replace('@', '.nuevo@');
    let cleanupToken = owner.token;

    try {
      await login(page);
      await page.goto('/platform-admin');

      const card = page.locator('mat-card').filter({ hasText: owner.businessName });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: /Modificar/ }).click();
      await card.getByLabel('Email de acceso del propietario').fill(updatedEmail);

      const updateResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/api/v1/platform-admin/businesses/${owner.businessId}/email`),
      );
      await card.getByRole('button', { name: 'Guardar', exact: true }).click();
      expect((await updateResponse).ok()).toBeTruthy();
      await expect(card.getByText(updatedEmail, { exact: true })).toBeVisible();

      const oldLogin = await request.post(`${env.backendUrl}/api/v1/auth/login`, {
        data: { email: owner.email, password: owner.password },
      });
      expect(oldLogin.status()).toBe(401);

      const newLogin = await request.post(`${env.backendUrl}/api/v1/auth/login`, {
        data: { email: updatedEmail, password: owner.password },
      });
      expect(newLogin.ok(), await newLogin.text()).toBeTruthy();
      const session = (await newLogin.json()) as { token?: string; accessToken?: string };
      cleanupToken = session.token ?? session.accessToken ?? '';
      expect(cleanupToken).toBeTruthy();
    } finally {
      if (cleanupToken) await deleteBusiness(request, owner.businessId, cleanupToken);
    }
  });
});

async function createOwnerAndBusiness(
  request: APIRequestContext,
  prefix: string,
): Promise<OwnerFixture> {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-admin-${prefix.toLowerCase()}-${suffix}@example.test`;
  const password = `E2e-Admin-${suffix}`;
  const registration = await request.post(`${env.backendUrl}/api/v1/auth/register`, {
    data: { name: `Owner ${prefix}`, email, password, role: 'BUSINESS' },
  });
  expect(registration.status(), await registration.text()).toBe(201);

  const loginResponse = await request.post(`${env.backendUrl}/api/v1/auth/login`, {
    data: { email, password },
  });
  expect(loginResponse.ok(), await loginResponse.text()).toBeTruthy();
  const session = (await loginResponse.json()) as { token?: string; accessToken?: string };
  const token = session.token ?? session.accessToken;
  expect(token).toBeTruthy();

  const businessName = `Comercio E2E ${prefix} ${suffix}`;
  const businessResponse = await request.post(`${env.backendUrl}/api/v1/businesses`, {
    headers: authorization(token!),
    data: {
      name: businessName,
      category: 'OTHERS',
      shortDescription: 'Fixture de administración de usuarios',
      contactEmail: email,
    },
  });
  expect(businessResponse.status(), await businessResponse.text()).toBe(201);
  const business = (await businessResponse.json()) as { id: string };
  return { businessId: business.id, businessName, email, password, token: token! };
}

async function deleteBusiness(
  request: APIRequestContext,
  businessId: string,
  token: string,
): Promise<void> {
  const response = await request.delete(`${env.backendUrl}/api/v1/businesses/${businessId}`, {
    headers: authorization(token),
  });
  expect(response.ok(), `No se pudo limpiar el comercio E2E ${businessId}`).toBeTruthy();
}

function authorization(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
