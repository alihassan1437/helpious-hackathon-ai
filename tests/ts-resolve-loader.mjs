// Node ESM resolution hook for tests: resolve extensionless relative
// imports (the form tsc + Next require) to their .ts files, so test
// files can import .ts sources that import each other extensionless.
// Bare specifiers (zod, node:*) pass through untouched.
// Usage: node --import ./tests/register.mjs tests/ai-provider.test.mjs
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    path.extname(specifier) === ''
  ) {
    const parentPath = fileURLToPath(context.parentURL);
    const candidate = path.resolve(path.dirname(parentPath), `${specifier}.ts`);
    if (existsSync(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
