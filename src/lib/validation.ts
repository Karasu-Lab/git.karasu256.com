import { z } from 'zod';

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function repositoryFullNameSchema() {
  return z
    .string()
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
    .refine((value) => value.split('/').every((segment) => segment !== '.' && segment !== '..'));
}

export function repositoryNameSchema() {
  return z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/)
    .refine((value) => value !== '.' && value !== '..');
}

export function ownerLoginSchema() {
  return z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
}

export function shaSchema() {
  return z.string().regex(/^[0-9a-f]{40}$/);
}

export function branchNameSchema() {
  return z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9._/-]+$/)
    .refine(
      (value) =>
        !value.includes('..') &&
        !value.includes('//') &&
        !value.startsWith('-') &&
        !value.startsWith('/') &&
        !value.endsWith('/') &&
        !value.endsWith('.lock')
    );
}

export function filePathSchema() {
  return z
    .string()
    .min(1)
    .max(500)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !/[\u0000-\u001f\u007f]/.test(value) &&
        value.split('/').every((segment) => segment !== '' && segment !== '..')
    );
}

export function fileContentSchema(maxBytes: number = 512 * 1024) {
  return z.string().refine((value) => byteLength(value) <= maxBytes);
}

export function clientPayloadSchema(maxKeys: number = 10, maxBytes: number = 8 * 1024) {
  return z
    .record(z.string(), z.json())
    .refine((value) => Object.keys(value).length <= maxKeys)
    .refine((value) => byteLength(JSON.stringify(value)) <= maxBytes);
}
