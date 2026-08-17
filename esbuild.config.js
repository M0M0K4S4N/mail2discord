import { build } from 'esbuild';

const buildOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'build/index.js',
  format: 'esm',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
};

build(buildOptions)
  .then(() => {
    console.log('Built build/index.js');
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
