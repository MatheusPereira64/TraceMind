import { z } from 'zod';
import { ENVIRONMENTS, ORGANIZATION_ROLES } from './enums.js';

/* ------------------------------------------------------------------ primitives */

export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');

export const passwordSchema = z
  .string()
  .min(10, 'Password must have at least 10 characters')
  .max(128, 'Password must have at most 128 characters');

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((value) => value.toLowerCase());

export const uuidSchema = z.uuid();

/** Converts an arbitrary display name into a URL-safe slug candidate. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/* ------------------------------------------------------------------------ auth */

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().trim().min(2).max(120),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // Do not apply the password policy on login: it would leak policy changes and is not needed.
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

/* --------------------------------------------------------------- organizations */

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema.optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const organizationRoleSchema = z.enum(ORGANIZATION_ROLES);

/* -------------------------------------------------------------------- projects */

export const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema.optional(),
  description: z.string().trim().max(500).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).nullable(),
    retentionDays: z.number().int().min(1).max(3650),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/* -------------------------------------------------------------------- api keys */

export const environmentSchema = z.enum(ENVIRONMENTS);

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  environment: environmentSchema.default('development'),
  /** Optional absolute expiry. Must be in the future. */
  expiresAt: z.iso
    .datetime({ offset: true })
    .refine((value) => new Date(value).getTime() > Date.now(), 'expiresAt must be in the future')
    .optional(),
});
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;

/* ------------------------------------------------------------------ pagination */

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
