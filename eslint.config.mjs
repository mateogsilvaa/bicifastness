import globals from 'globals';

/**
 * Configuracion minima y a proposito: solo reglas que detectan ERRORES reales,
 * no estilo. Lo que se busca es que no vuelva a colarse una variable fuera de
 * ambito en el JavaScript incrustado en las paginas.
 */
export default [
  { ignores: ['**/node_modules/**', 'assets/data/**', 'backend/lib/**', 'data/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Bibliotecas que llegan por <script> y no por import.
        L: 'readonly',
        html2canvas: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-compare': 'error',
      'require-atomic-updates': 'off',
    },
  },
  {
    // El backend es CommonJS y corre en Node.
    files: ['backend/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
];
