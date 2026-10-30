// Registers the extensionless-.ts resolution hook for provider tests.
// Usage: node --import ./tests/register.mjs tests/ai-provider.test.mjs
import { register } from 'node:module';

register('./ts-resolve-loader.mjs', import.meta.url);
