/**
 * Builds the FileSystemTree mounted into the WebContainer.
 * The DApp sources live as real files in ../wc-app/ (so they get syntax
 * checking and highlighting) and are inlined here at build time via
 * Vite's `?raw` imports.
 */

import type { FileSystemTree } from '@webcontainer/api';

import pkgJson from '../wc-app/package.json?raw';
import viteConfig from '../wc-app/vite.config.ts?raw';
import tsconfigJson from '../wc-app/tsconfig.json?raw';
import indexHtml from '../wc-app/index.html?raw';
import mainTsx from '../wc-app/src/main.tsx?raw';
import appTsx from '../wc-app/src/App.tsx?raw';
import indexCss from '../wc-app/src/index.css?raw';
import reportTs from '../wc-app/src/report.ts?raw';
import utilsTs from '../wc-app/src/lib/utils.ts?raw';
import buttonTsx from '../wc-app/src/components/ui/button.tsx?raw';
import cardTsx from '../wc-app/src/components/ui/card.tsx?raw';
import badgeTsx from '../wc-app/src/components/ui/badge.tsx?raw';
// The exact same wallet check that the host page runs, mounted into the DApp.
import walletCheckTs from './wallet-check.ts?raw';

const file = (contents: string) => ({ file: { contents } });

export function makeProjectFiles(hostPort: string): FileSystemTree {
  return {
    'package.json': file(pkgJson),
    'vite.config.ts': file(viteConfig),
    'tsconfig.json': file(tsconfigJson),
    'index.html': file(indexHtml),
    // Written to by the Vite /__nyx-report middleware inside the container;
    // watched by the host page which relays each line to the Rust server.
    'nyx-reports.ndjson': file(''),
    src: {
      directory: {
        'main.tsx': file(mainTsx),
        'App.tsx': file(appTsx),
        'index.css': file(indexCss),
        'wallet-check.ts': file(walletCheckTs),
        'report.ts': file(reportTs.replaceAll('__HOST_PORT__', hostPort)),
        lib: {
          directory: {
            'utils.ts': file(utilsTs),
          },
        },
        components: {
          directory: {
            ui: {
              directory: {
                'button.tsx': file(buttonTsx),
                'card.tsx': file(cardTsx),
                'badge.tsx': file(badgeTsx),
              },
            },
          },
        },
      },
    },
  };
}
