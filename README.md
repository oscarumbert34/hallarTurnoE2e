# HallarTurno E2E

Proyecto independiente de pruebas End-to-End para los flujos principales de HallarTurno. Usa Playwright, TypeScript y Chromium contra el frontend, backend y PostgreSQL locales; no inicia esos servicios ni debe apuntar a producción.

## Requisitos

- Node.js 20 o posterior y npm.
- Chromium de Playwright (`npx playwright install chromium` la primera vez).
- Frontend Angular de HallarTurno levantado localmente.
- Backend Spring Boot levantado con el perfil local y conectado a una base PostgreSQL exclusiva para E2E.
- Una fecha futura con al menos dos horarios disponibles para el fixture.

## Instalación y configuración

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

En PowerShell, el último comando puede reemplazarse por:

```powershell
Copy-Item .env.example .env
```

Editá `.env` con las URLs locales y los datos del fixture. `.env` está ignorado por Git; sólo `.env.example`, sin secretos, se versiona. `BACKEND_URL` es el origen (por ejemplo `http://localhost:8080`), sin `/api/v1`.

## Servicios y base local

La preparación exacta depende de los repositorios de la aplicación. En una configuración local habitual:

1. Creá una base separada, por ejemplo `hallarturno_e2e`. No reutilices desarrollo ni producción.
2. Configurá el backend con el perfil local y las variables `DB_URL`, `DB_USERNAME` y `DB_PASSWORD` apuntando exclusivamente a esa base; iniciá Spring Boot desde el repositorio backend.
3. Verificá que el frontend use ese backend en `apiBaseUrl` e iniciá Angular desde el repositorio frontend.
4. Abrí las URLs de `.env` y comprobá que respondan antes de ejecutar Playwright.

Este proyecto no levanta frontend, backend ni base de datos deliberadamente, según el alcance acordado.

## Preparar el fixture

En la base E2E debe existir un usuario con rol `BUSINESS` y contraseña conocida, asociado a un negocio activo. Creá desde la aplicación o las APIs locales:

- un negocio activo con nombre y slug iguales a `E2E_BUSINESS_NAME` y `E2E_BUSINESS_SLUG`;
- una sucursal activa `E2E_BRANCH_NAME`, con agenda para `E2E_BOOKING_DATE`;
- un servicio activo `E2E_SERVICE_NAME` ofrecido en esa sucursal;
- un recurso activo `E2E_RESOURCE_NAME`, vinculado al servicio y disponible ese día;
- al menos dos horarios futuros libres en la fecha configurada.

El fixture estructural es estable y se reutiliza. Cada prueba genera un cliente cuyo nombre comienza con `E2E` y teléfono/email únicos. Cada turno creado se cancela en un bloque de limpieza, aun cuando falle una aserción. Se usa un solo worker para evitar que los escenarios compitan por horarios.

Si se cambia `E2E_BOOKING_DATE`, actualizá también la agenda/excepciones del fixture. Conviene moverla periódicamente a una fecha futura conocida.

## Ejecutar

```bash
npm run test:e2e
```

La ejecución normal es headless y usa únicamente Chromium. Para depurar visualmente:

```bash
npm run test:e2e:headed
npm run test:e2e:ui
```

Para ejecutar un escenario puntual:

```bash
npx playwright test -g "reserva desde la página pública" --headed
```

## Evidencias y reporte

Siempre se genera el reporte HTML en `playwright-report/`. Abrilo con:

```bash
npm run test:e2e:report
```

Cuando una prueba falla, Playwright conserva screenshot, video y trace en `test-results/`. Para inspeccionar un trace:

```bash
npx playwright show-trace test-results/RUTA-AL-TRACE/trace.zip
```

El trace incluye acciones, DOM, red y consola, y suele ser el punto de partida más útil. Ninguna evidencia ni reporte se versiona.

## Selectores

Las pruebas priorizan roles, labels y nombres accesibles que hoy forman parte de la interfaz estable. Playwright queda configurado para `data-testid`; si un control importante deja de tener un nombre accesible estable, agregá `data-testid` en el frontend y usá `page.getByTestId(...)` en lugar de selectores de estructura. Las clases se usan sólo para delimitar componentes repetidos de la agenda actual.

## Alcance automatizado

- Login del responsable, redirección a Reservas y comprobación de la sucursal del negocio en el panel.
- Creación manual desde la búsqueda autenticada, comprobación en agenda, cancelación desde el detalle y comprobación de que deja de estar activa.
- Reserva desde la página pública, confirmación y comprobación posterior en la agenda autenticada.

Las rutas del negocio son canónicas y contienen `E2E_BUSINESS_SLUG`: `/:slug/search`,
`/:slug/booking`, `/:slug/bookings` y `/:slug/business-dashboard`. El login debe devolver
`businessSlug` y redirigir a `/:slug/bookings`. El alta manual se inicia en **Búsqueda** y se
administra en **Reservas**; no existe un formulario de alta dentro de la pantalla de agenda.
