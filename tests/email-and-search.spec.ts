import { expect, test } from '@playwright/test';
import { env, routes } from './support/environment';
import { authenticatedFixture, loginThroughApi } from './support/api';
import { login } from './support/ui';

test.describe('configuración de correos', () => {
  test('expone el estado de correos desde la API protegida', async ({ request }) => {
    const token = await loginThroughApi(request);
    const businessResponse = await request.get(
      `${env.backendUrl}/api/v1/public/businesses/${encodeURIComponent(env.businessSlug)}`,
    );
    expect(businessResponse.ok()).toBeTruthy();
    const business = (await businessResponse.json()) as { id: string };

    const response = await request.get(
      `${env.backendUrl}/api/v1/businesses/${business.id}/emails`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.ok(), `Falló el estado de correos: ${response.status()} ${await response.text()}`).toBeTruthy();
    const status = (await response.json()) as {
      addon: string;
      automations: unknown[];
      usage: { used: number; limit: number; remaining: number };
    };
    expect(status.addon).toBeTruthy();
    expect(status.automations).toHaveLength(5);
    expect(status.usage.used).toBeGreaterThanOrEqual(0);
    expect(status.usage.remaining).toBeGreaterThanOrEqual(0);
  });

  test('muestra estado, consumo y las cuatro preferencias reales', async ({ page }) => {
    await login(page);
    const statusResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/businesses/') &&
        response.url().endsWith('/emails') &&
        response.request().method() === 'GET',
    );

    const emailsLink = page.getByRole('link', { name: 'Mis correos', exact: true }).first();
    await expect(
      emailsLink,
      'La versión desplegada no expone Mis correos en la navegación',
    ).toBeVisible();
    await emailsLink.click();
    await expect(page).toHaveURL(new RegExp(`${routes.emails}$`));
    expect((await statusResponse).ok()).toBeTruthy();

    await expect(page.getByRole('heading', { name: 'Mis correos' })).toBeVisible();
    await expect(page.getByText('Consumo mensual')).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Confirmación y reprogramación al cliente' }),
    ).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(4);
    await expect(page.getByRole('switch', { name: 'Aviso de reprogramación' })).toHaveCount(0);
  });

  test('guarda una preferencia y la conserva al recargar', async ({ page }) => {
    await login(page);
    await page.goto(routes.emails);
    const confirmation = page.getByRole('switch', {
      name: 'Confirmación y reprogramación al cliente',
    });
    await expect(confirmation).toBeVisible();
    const originalValue = await confirmation.isChecked();

    try {
      await confirmation.click();
      const saveResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/emails/preferences') &&
          response.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: 'Guardar cambios' }).click();
      expect((await saveResponse).ok()).toBeTruthy();
      await expect(page.getByRole('status').filter({ hasText: 'Preferencias guardadas' })).toBeVisible();

      await page.reload();
      await expect(confirmation).toBeChecked({ checked: !originalValue });
    } finally {
      if ((await confirmation.isChecked()) !== originalValue) {
        await confirmation.click();
        const restoreResponse = page.waitForResponse(
          (response) =>
            response.url().endsWith('/emails/preferences') &&
            response.request().method() === 'PUT',
        );
        await page.getByRole('button', { name: 'Guardar cambios' }).click();
        expect((await restoreResponse).ok(), 'No se pudo restaurar la preferencia de correos').toBeTruthy();
      }
    }
  });

  test('muestra los avisos de cuota al 80, 95 y 100 por ciento sin usar el proveedor', async ({ page, request }) => {
    test.setTimeout(120_000);
    const fixture = await authenticatedFixture(request);
    const headers = { Authorization: `Bearer ${fixture.token}` };
    const statusResponse = await request.get(
      `${env.backendUrl}/api/v1/businesses/${fixture.businessId}/emails`,
      { headers },
    );
    expect(statusResponse.ok()).toBeTruthy();
    const original = (await statusResponse.json()) as {
      usage: { used: number; limit: number; growthAgendaUsed: number };
    };
    expect(original.usage.limit).toBeGreaterThan(0);
    const setSyntheticUsage = async (used: number) => {
      const response = await request.put(
        `${env.backendUrl}/api/v1/testing/businesses/${fixture.businessId}/email-usage`,
        {
          headers,
          data: { addonUsed: used, growthAgendaUsed: original.usage.growthAgendaUsed },
        },
      );
      expect(
        response.ok(),
        `El backend E2E debe iniciarse con SPRING_PROFILES_ACTIVE=e2e: ${response.status()} ${await response.text()}`,
      ).toBeTruthy();
    };

    try {
      await login(page);

      const warningUsage = Math.ceil(original.usage.limit * 0.8);
      await setSyntheticUsage(warningUsage);
      await page.goto(routes.emails);
      await expect(page.getByText('Ya usaste el 80% de tu cupo')).toBeVisible();
      await expect(page.getByText(`${original.usage.limit - warningUsage} disponibles`)).toBeVisible();

      const criticalUsage = Math.ceil(original.usage.limit * 0.95);
      await setSyntheticUsage(criticalUsage);
      await page.reload();
      await expect(page.getByText('Tu cupo está casi agotado')).toBeVisible();
      await expect(page.getByText(`${original.usage.limit - criticalUsage} disponibles`)).toBeVisible();

      await setSyntheticUsage(original.usage.limit);
      await page.reload();
      await expect(page.getByText('Alcanzaste el cupo mensual')).toBeVisible();
      await expect(page.getByText('0 disponibles')).toBeVisible();
    } finally {
      const restore = await request.put(
        `${env.backendUrl}/api/v1/testing/businesses/${fixture.businessId}/email-usage`,
        {
          headers,
          data: {
            addonUsed: original.usage.used,
            growthAgendaUsed: original.usage.growthAgendaUsed,
          },
        },
      );
      expect(restore.ok(), 'No se pudo restaurar el consumo sintético').toBeTruthy();
    }
  });
});

test.describe('carga segura de búsqueda', () => {
  test('mantiene Buscar deshabilitado hasta cargar los datos del negocio', async ({ page }) => {
    await login(page);
    let delayedRequest = false;
    await page.route('**/api/v1/businesses/*/branches', async (route) => {
      delayedRequest = true;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.continue();
    });

    await page.getByRole('link', { name: 'Busqueda', exact: true }).first().click();
    const searchButton = page.getByRole('button', { name: 'Buscar', exact: true });
    await expect(searchButton).toBeDisabled();
    await expect.poll(() => delayedRequest).toBe(true);
    await expect(searchButton).toBeEnabled();
    await page.getByLabel('Sucursal', { exact: true }).click();
    await expect(page.getByRole('option', { name: env.branchName })).toBeVisible();
  });
});
