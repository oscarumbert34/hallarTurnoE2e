const requiredNames = [
  'FRONTEND_URL',
  'BACKEND_URL',
  'E2E_USER_EMAIL',
  'E2E_USER_PASSWORD',
  'E2E_BUSINESS_NAME',
  'E2E_BUSINESS_SLUG',
  'E2E_BRANCH_NAME',
  'E2E_SERVICE_NAME',
  'E2E_RESOURCE_NAME',
  'E2E_BOOKING_DATE',
] as const;

type RequiredName = (typeof requiredNames)[number];

function required(name: RequiredName): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta ${name}. Copiá .env.example a .env y completá el fixture E2E.`);
  }
  return value;
}

const bookingDate = required('E2E_BOOKING_DATE');
if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
  throw new Error('E2E_BOOKING_DATE debe usar el formato AAAA-MM-DD.');
}
const today = new Date();
const localToday = [
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, '0'),
  String(today.getDate()).padStart(2, '0'),
].join('-');
if (bookingDate <= localToday) {
  throw new Error(
    `E2E_BOOKING_DATE (${bookingDate}) debe ser posterior a hoy (${localToday}) y tener al menos tres horarios disponibles.`,
  );
}

export const env = {
  frontendUrl: required('FRONTEND_URL').replace(/\/$/, ''),
  backendUrl: required('BACKEND_URL').replace(/\/$/, ''),
  email: required('E2E_USER_EMAIL'),
  password: required('E2E_USER_PASSWORD'),
  businessName: required('E2E_BUSINESS_NAME'),
  businessSlug: required('E2E_BUSINESS_SLUG'),
  branchName: required('E2E_BRANCH_NAME'),
  serviceName: required('E2E_SERVICE_NAME'),
  resourceName: required('E2E_RESOURCE_NAME'),
  bookingDate,
};

export const routes = {
  login: '/auth/login',
  publicBusiness: `/business/${required('E2E_BUSINESS_SLUG')}`,
  search: `/${required('E2E_BUSINESS_SLUG')}/search`,
  booking: `/${required('E2E_BUSINESS_SLUG')}/booking`,
  bookings: `/${required('E2E_BUSINESS_SLUG')}/bookings`,
  emails: `/${required('E2E_BUSINESS_SLUG')}/emails`,
  dashboard: `/${required('E2E_BUSINESS_SLUG')}/business-dashboard`,
};

export function uniqueCustomer(prefix: string): { name: string; phone: string; email: string } {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const digits = suffix.slice(-8).padStart(8, '0');
  return {
    name: `E2E ${prefix} ${suffix}`,
    phone: `11${digits}`,
    email: `e2e-${prefix.toLowerCase()}-${suffix}@example.test`,
  };
}
