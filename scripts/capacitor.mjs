import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const os = require('node:os');

// Some managed Windows shells return ENOMEM from uv_os_get_passwd. Capacitor
// only uses this profile information for terminal display, so provide the
// current Windows profile as a safe fallback before loading its CLI.
const originalUserInfo = os.userInfo;
os.userInfo = (...args) => {
  try {
    return originalUserInfo(...args);
  } catch {
    return {
      username: process.env.USERNAME || 'DataShopGH',
      uid: -1,
      gid: -1,
      shell: null,
      homedir: process.env.USERPROFILE || process.cwd(),
    };
  }
};

process.argv[1] = fileURLToPath(new URL('../node_modules/@capacitor/cli/bin/capacitor', import.meta.url));
require(process.argv[1]);
