qrcode-generator 1.4.4 (MIT, Kazuhiko Arase, https://github.com/kazuhikoarase/qrcode-generator),
copiado de su paquete de npm. Lo unico cambiado: el envoltorio UMD del final se
ha sustituido por `export default qrcode;` para importarlo como modulo ES (la CSP
no deja cargar scripts de un CDN). Lo usa `assets/js/dos-pasos.js` para pintar el
QR de la verificacion en dos pasos sin que el secreto salga del navegador.
