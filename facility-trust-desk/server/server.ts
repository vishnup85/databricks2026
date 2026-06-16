import { createApp, analytics, lakebase, server } from '@databricks/appkit';
import { setupTrustDeskOverrides } from './trustDeskOverrides';

await createApp({
  plugins: [analytics(), server(), lakebase()],
  async onPluginsReady(appkit) {
    await setupTrustDeskOverrides(appkit);
  },
}).catch(console.error);
