import { defineConfig } from 'drizzle-kit';

// Used only by `npm run db:generate` (SQL migration files). Never use `drizzle-kit push` on a user DB.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
