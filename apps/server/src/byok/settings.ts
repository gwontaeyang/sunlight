import { UserSettings } from '@study-paper/shared/contracts/api';
import type { Sqlite } from '../db/client';

const defaults: UserSettings = {
  'llm.backend': 'subscription',
  'llm.monthlyLimitMicroUsd': null,
  'llm.economy': false,
  'llm.answerLanguage': 'ko',
  'study.codeLanguage': 'cpp17',
};
export function readSettings(sqlite: Sqlite): UserSettings {
  const values = { ...defaults };
  const query = sqlite.prepare('SELECT valueJson FROM settings WHERE key=?');
  for (const key of Object.keys(defaults)) {
    const row = query.get(key) as { valueJson: string } | undefined;
    if (row) Object.assign(values, { [key]: JSON.parse(row.valueJson) });
  }
  return UserSettings.parse(values);
}
export function writeSettings(sqlite: Sqlite, values: Partial<UserSettings>) {
  const patch = UserSettings.partial().parse(values);
  const update = sqlite.prepare(
    'INSERT INTO settings(key,valueJson) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET valueJson=excluded.valueJson',
  );
  sqlite.transaction(() => {
    for (const [key, value] of Object.entries(patch)) update.run(key, JSON.stringify(value));
  })();
}
