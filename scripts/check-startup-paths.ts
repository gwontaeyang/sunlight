import { assertStartupPaths } from '../apps/server/src/security/startupPaths';
import { credentialDirectory } from '../apps/server/src/byok/credentials';
assertStartupPaths();
credentialDirectory(process.env, false);
