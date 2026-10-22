'use strict';

/**
 * Ships the shared `pycommon` package inside a Lambda artifact.
 *
 * Why this exists
 * ---------------
 * `pycommon` is a monorepo package (`packages/pycommon`), not a PyPI
 * distribution, so it can never be a plain `requirements.txt` entry:
 *
 *   - pip resolves a local path requirement against the CURRENT WORKING
 *     DIRECTORY, and a bare `../../packages/pycommon` is not even valid
 *     requirement syntax.
 *   - The Lambda build runs pip inside a Linux container that only sees
 *     the requirements folder — the monorepo is not mounted there, so a
 *     relative path can never resolve.
 *
 * So the package's SOURCE is copied into the service tree for the
 * duration of the build: Serverless packs the service tree at the
 * artifact root, and `import pycommon` finds it there exactly like any
 * other first-party module. The copy is removed once the artifact is
 * built, so a developer's working tree stays clean.
 *
 * Consumers add it to their plugin list:
 *
 *   plugins:
 *     - ../../scripts/serverless-vendor-pycommon.js
 */

const fs = require('fs');
const path = require('path');

/** Where the shared package lives, relative to a service directory. */
const SOURCE_RELATIVE_PATH = path.join('..', '..', 'packages', 'pycommon');

class VendorPycommonPlugin {
  constructor(serverless) {
    this.serverless = serverless;
    this.commands = {};
    this.hooks = {
      'before:package:createDeploymentArtifacts': () => this.vendor(),
      'after:package:createDeploymentArtifacts': () => this.cleanup(),
    };
  }

  /** Copy the shared package into the service tree so it gets packed. */
  vendor() {
    const serviceDir = this.serverless.serviceDir;
    const packageRoot = path.resolve(serviceDir, SOURCE_RELATIVE_PATH);
    const source = path.join(packageRoot, 'pycommon');
    const target = path.join(serviceDir, 'pycommon');

    if (!fs.existsSync(source)) {
      throw new Error(
        `VendorPycommon: cannot find the shared package at ${source}. ` +
          'Is this service still inside the monorepo layout?'
      );
    }

    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, {
      recursive: true,
      // Byte-code caches are build artifacts of the local checkout, not
      // something the Lambda runtime should ever see.
      filter: (entry) =>
        !entry.includes(`${path.sep}__pycache__${path.sep}`) &&
        !entry.endsWith('.pyc'),
    });

    this.target = target;
    this.serverless.cli.log(`VendorPycommon: packed ${source} into the artifact`);
  }

  /** Leave the developer's tree as we found it. */
  cleanup() {
    if (!this.target) return;
    fs.rmSync(this.target, { recursive: true, force: true });
    this.target = undefined;
  }
}

module.exports = VendorPycommonPlugin;
