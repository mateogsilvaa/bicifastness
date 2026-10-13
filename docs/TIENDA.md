# Tienda: camisetas y tazas con tus marcas

Merchandising impreso bajo demanda con los datos reales de cada piloto: su
nombre, el escudo de su clan, su mejor tiempo en un tramo y su puesto en el
ranking general. El dinero que sale de aquí ayuda a pagar el proyecto.

## Cómo funciona

BiciFastness no tiene servidor propio. La web es estática (GitHub Pages) y el
único proceso de confianza es el worker, que corre en GitHub Actions. Por eso
el flujo «normal» (un endpoint que crea la sesión de Stripe y otro que recibe
el webhook) se ha adaptado así:

```
Navegador ── 1. vista previa (SVG, con tus datos)
    │
    ├─ 2. crea pedidos_tienda/{id}  (borrador: producto, talla, qué trayecto)
    └─ 3. va al Payment Link de Stripe con ?client_reference_id={id}
                       │
                 Stripe cobra y recoge la dirección
                       │
Worker (cada ejecución) ── 4. pregunta a Stripe por las sesiones completadas
    │                        (hace de webhook, pero tirando en vez de recibir)
    ├─ 5. comprueba que lo cobrado es el precio del producto
    ├─ 6. saca los datos de Firestore (NO del navegador) y pinta el diseño
    ├─ 7. SVG → PNG con sharp → lo sube a Cloudinary
    └─ 8. crea el pedido en Printful con la dirección y la URL del PNG
```

Piezas:

| Qué | Dónde |
|---|---|
| El diseño (el mismo para vista previa e impresión) | `assets/js/tienda-diseno.js` |
| La página | `tienda/`, `assets/js/paginas/tienda.js` |
| Acceso en Tú e invitación en Hoy | `assets/js/tienda.js` |
| Abrir/cerrar y configurar | `/admin/tienda/` → `config/tienda` |
| Del pago a la imprenta | `backend/src/tienda.js` (lo llama el worker) |
| Reglas | `firestore.rules`: `config/tienda`, `pedidos_tienda`, `tienda_interno` |

## Puesta en marcha

1. **Printful.** Crea una tienda de tipo «Manual order platform / API». Genera
   un token privado (Settings → API) con permiso de pedidos. Apunta el id de
   variante de cada talla: catálogo → producto → «Variants», o
   `GET https://api.printful.com/products/{id}`. Ejemplos habituales (compruébalos
   en el catálogo, los ids cambian por color y talla): Bella+Canvas 3001 negra y
   la taza blanca brillante de 11 oz.
2. **Cloudinary.** Cuenta gratuita. Necesitas el *cloud name*, la *API key* y el
   *API secret* (Dashboard). Solo se usa para alojar el PNG que lee Printful.
3. **Stripe.** Un *Payment Link* por producto (Camiseta, Taza):
   - Precio fijo en EUR, cantidad no ajustable.
   - «Recoger direcciones de envío» activado, con los países a los que envíes.
   - Tras el pago, redirigir a `https://bicifastness.app/tienda/?gracias=1`.
   - Crea una **clave restringida** con permiso de *lectura* en «Checkout
     Sessions». Es la única que necesita el worker: no puede cobrar ni
     devolver nada.
   - Prueba primero en modo test: los enlaces `buy.stripe.com/test_…` y la
     clave `rk_test_…` funcionan igual.
4. **Secretos del repositorio** (Settings → Secrets and variables → Actions):
   `STRIPE_SECRET_KEY`, `PRINTFUL_TOKEN`, `PRINTFUL_STORE_ID` (si el token es de
   cuenta y no de tienda), `CLOUDINARY_CLOUD`, `CLOUDINARY_API_KEY`,
   `CLOUDINARY_API_SECRET`. Sin `STRIPE_SECRET_KEY` el worker no toca la tienda.
5. **`/admin/tienda/`**: pega los enlaces de pago, el precio (el mismo que en
   Stripe) y las variantes (`M=4012`, una por línea), marca «A la venta» y
   pon la tienda «Visible».
6. Los primeros pedidos llegan a Printful como **borrador**: los confirmas tú
   desde su panel después de mirar el diseño. Cuando te fíes, crea la variable
   de repositorio `TIENDA_CONFIRMAR` = `si` y saldrán directos a producción.

Antes de abrirla de verdad: unas condiciones de venta (quién vende, NIF,
envíos, devoluciones) y, si se factura, el IVA. La página ya explica que, al
ser personalizado, no hay desistimiento (art. 103.c TRLGDCU), pero eso no
sustituye a unas condiciones.

## Que no moleste

- Cerrada en `/admin/tienda/`, no aparece en ningún sitio.
- Abierta: una entrada al final del menú de Tú y, como mucho, **una tarjeta en
  Hoy**: solo para quien lleva 5 trayectos verificados y una semana de cuenta,
  una vez al mes, tres veces en total, nunca si ya hay otra invitación en
  pantalla, y con «No volver a mostrar».

## Las cuatro preguntas

### 1. La plantilla y la URL dinámica: ¿Cloudinary o código?

Código. Cloudinary puede montar el diseño con capas en la URL
(`l_text:Arial_80_bold:pepa,co_white,g_north,y_300/…`), pero:

- el texto hay que escaparlo a su manera (comas, barras, `%`), y un nombre con
  caracteres raros rompe la URL;
- no mide el texto: o adivinas el tamaño o se sale;
- la vista previa del navegador sería otra cosa distinta de lo que se imprime.

Aquí el diseño es una función que devuelve un SVG (`disenoSVG`). El navegador
lo enseña tal cual y el worker lo convierte en PNG de 3600×4800 (camiseta,
12×16" a 300 ppp) o 2700×1050 (taza) con `sharp`, que ya usaba para las
capturas. Cloudinary solo **aloja** el PNG, porque Printful necesita una URL
pública y en el plan gratuito de Firebase no hay Storage. Si algún día se
prefiere la plantilla de Cloudinary, la URL sería:

```
https://res.cloudinary.com/<nube>/image/upload/
  l_text:Archivo_220_black:<nombre-escapado>,co_rgb:F2F1EE,g_north_west,x_90,y_250/
  l_text:Archivo_330_black:12%3A29,co_rgb:F2F1EE,g_north_west,x_90,y_700/
  plantilla-camiseta.png
```

### 2. El endpoint que crea la sesión de Stripe

No hace falta: el **Payment Link** es una sesión de Checkout ya configurada en
Stripe, y admite `?client_reference_id=` para atarla al pedido. Ventaja de
seguridad: el precio vive en Stripe y la web no puede tocarlo. Si algún día
hay servidor (Cloud Run, Cloudflare Workers), el equivalente es:

```js
const sesion = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{ price: PRECIO_CAMISETA, quantity: 1 }],
  client_reference_id: pedidoId,
  shipping_address_collection: { allowed_countries: ['ES', 'PT', 'FR', 'IT', 'DE'] },
  success_url: 'https://bicifastness.app/tienda/?gracias=1',
  cancel_url: 'https://bicifastness.app/tienda/',
});
res.redirect(303, sesion.url);
```

### 3. El webhook y el pedido a Printful

Sin servidor no hay a dónde mande Stripe el webhook, así que el worker
**pregunta**: `GET /v1/checkout/sessions?status=complete&created[gte]=…`,
desde la última vez que miró (`tienda_interno/stripe`). Tarda lo que tarde la
siguiente ejecución del worker (unos minutos), que para un pedido que se
imprime en días no importa. El pedido a Printful (`cuerpoPrintful`):

```json
{
  "external_id": "uid_20375_0",
  "shipping": "STANDARD",
  "recipient": { "name": "…", "address1": "…", "city": "Madrid", "country_code": "ES", "zip": "28013", "email": "…" },
  "items": [{ "variant_id": 4012, "quantity": 1, "retail_price": "24.90",
              "files": [{ "type": "front", "url": "https://res.cloudinary.com/…png" }] }]
}
```

`external_id` es el id de nuestro pedido, y antes de crearlo se pregunta
`GET /orders/@{external_id}`: una ejecución cortada a medias nunca duplica un
pedido. Si lo cobrado no cuadra con el precio, falta la dirección o la talla
no tiene variante, el pedido queda «a revisar» y te llega un correo. Un fallo
de red se reintenta tres veces antes de avisar.

### 4. Nombres largos y textos que rompen el diseño

Todo texto pasa por dos filtros (`tienda-diseno.js`):

- **`limpiar`**: normaliza, quita emojis y caracteres que la imprenta no tiene
  (saldrían cuadraditos), colapsa espacios y recorta con «…» a un máximo por
  campo (22 el nombre, 26 el clan, 34 cada estación).
- **`linea`**: estima el ancho por letra (por lo alto: la imprenta no tiene
  Archivo y usa otra), **encoge la letra** hasta que cabe; si ni al mínimo
  cabe, **recorta**; y además fija `textLength` con
  `lengthAdjust="spacingAndGlyphs"`, que obliga al renderizador a apretar la
  línea antes que desbordarla. El tiempo nunca se recorta, solo encoge.

Y lo de siempre con texto que viene de la base de datos: se escapa para XML
(un nombre con `<script>` no puede romper el SVG), el color del clan solo
entra si es `#RRGGBB` y el trazo del emblema solo si es un `d` de SVG. Lo
prueban `backend/test/tienda.test.js` y los PNG se pueden generar en local con
`sharp` para mirarlos.
