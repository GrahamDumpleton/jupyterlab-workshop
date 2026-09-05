/**
 * Bundle the Node entry of the core package, with its dependencies, into
 * a single CommonJS file inside the Python package, and copy the manifest
 * schema next to it. The `jupyter workshop` CLI runs the bundle with
 * whatever `node` is on the path, so nothing else needs installing.
 */

const fs = require('fs');
const path = require('path');

const { rspack } = require('@rspack/core');

const root = path.resolve(__dirname, '..');
const target = path.resolve(root, '../../educates_jupyterlab_workshop/nodejs');
const schemaTarget = path.resolve(
  root,
  '../../educates_jupyterlab_workshop/schema'
);

rspack(
  {
    mode: 'production',
    target: 'node18',
    entry: path.join(root, 'src/node/main.ts'),
    output: {
      path: target,
      filename: 'workshop-cli.cjs',
      library: { type: 'commonjs2' },
      clean: true
    },
    resolve: { extensions: ['.ts', '.js', '.json'] },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: 'builtin:swc-loader',
          options: {
            jsc: { parser: { syntax: 'typescript' }, target: 'es2020' }
          }
        }
      ]
    },
    devtool: false,
    optimization: { minimize: false }
  },
  (error, stats) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }

    if (stats && stats.hasErrors()) {
      console.error(stats.toString({ colors: false }));
      process.exit(1);
    }

    fs.mkdirSync(schemaTarget, { recursive: true });

    for (const name of ['workshop.schema.json', 'registry.schema.json']) {
      fs.copyFileSync(
        path.join(root, 'src/schema', name),
        path.join(schemaTarget, name)
      );
    }

    console.log(`Wrote ${path.join(target, 'workshop-cli.cjs')}`);
  }
);
