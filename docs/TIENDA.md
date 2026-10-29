# Tienda: camisetas y tazas con tus marcas

Merchandising impreso bajo demanda con los datos reales de cada piloto: su
nombre, el escudo de su clan, su mejor tiempo en un tramo y su puesto en el
ranking general. El dinero que sale de aquí ayuda a pagar el proyecto.

## Cómo funciona (Polar)

Casi ninguna pasarela deja vender artículos físicos a un proyecto así, así que
en **Polar se venden artículos digitales** (un pack de apoyo, paquetes de
gemas) y la pieza impresa es un **regalo** que acompaña al pack. Polar no sabe
de direcciones ni de tallas y la imprenta no sabe de Polar: el puente es
nuestro (`backend/src/tienda.js`).

```
Navegador ── 1. vista previa (SVG, con tus datos)
    ├─ 2. pide la DIRECCION de envio (la recogemos nosotros)
    ├─ 3. crea pedidos_tienda/{id} (borrador: producto, talla, trayecto, envio)
    └─ 4. va al checkout link de Polar con ?customer_external_id={uid}&reference_id={id}
                       │
                 Polar cobra el pack digital
                       │
Worker (cada ejecucion) ── 5. GET /v1/orders/ de Polar desde la ultima vez
    ├─ 6. casa el pedido: por su id, o por cliente (uid) + producto + borrador mas reciente
    ├─ 7. comprueba que lo cobrado es el precio
    ├─ gemas  → las suma al perfil (una sola vez, en transaccion)
    └─ fisico → Printful (diseño desde Firestore, PNG a Cloudinary)
                o, sin claves de imprenta, "ENVIAR A MANO" + correo con la direccion
```

Las **gemas** se gastan en banners y lemas desde la tienda: la web deja
`canjes_gemas/{uid}` y el worker decide (precio en `config/tienda.gemas.precios`,
saldo suficiente, que no lo tenga ya). La página deja claro que **todo se puede
conseguir gratis jugando**; comprarlo es solo una forma de apoyar.

| Qué | Dónde |
|---|---|
| El diseño (el mismo para vista previa e impresión) | `assets/js/tienda-diseno.js` |
| La página (dirección, gemas) | `tienda/`, `assets/js/paginas/tienda.js` |
| Abrir/cerrar, enlaces, packs, precios en gemas, marcar enviado | `/admin/tienda/` → `config/tienda` |
| Del pago al envío, y canjes de gemas | `backend/src/tienda.js` (lo llama el worker) |
| Reglas | `firestore.rules`: `config/tienda`, `pedidos_tienda`, `canjes_gemas`, `tienda_interno` |

## Puesta en marcha

1. **Polar.** Crea los productos digitales (p. ej. «Pack de apoyo · camiseta»,
   «Pack de apoyo · taza», «100 gemas»…) en EUR, y un *checkout link* de cada
   uno. Pon como URL de éxito `https://bicifastness.es/tienda/?gracias=1`.
2. **Token.** Polar → Settings → *Organization Access Token* con permiso de
   lectura de pedidos (`orders:read`). Secreto del repo `POLAR_ACCESS_TOKEN`;
   variables `POLAR_ORGANIZATION_ID` y, para probar, `POLAR_SANDBOX=si`.
3. **`/admin/tienda/`**: pega cada enlace y el **id del producto de Polar** (es
   lo que permite casar el pago aunque el enlace no devuelva nuestro id), el
   precio (el mismo que en Polar), las tallas y los packs de gemas.
4. **Envío.** Sin `PRINTFUL_TOKEN` y las tres de Cloudinary, cada pedido pagado
   queda como «ENVIAR A MANO» en el panel con su dirección, y te llega un
   correo; lo marcas como enviado allí. Con ellas, va a Printful como antes
   (borrador salvo `TIENDA_CONFIRMAR=si`).

**Comprobar antes de abrir:** que Polar acepte un regalo físico como extra de
un producto digital en sus condiciones, y que los parámetros
`customer_external_id`/`reference_id` del checkout link funcionen en tu cuenta
(si no, el casado por id de producto + uid no funciona y los pagos llegan como
«pago sin pedido» para resolver a mano). Unas condiciones de venta propias
siguen haciendo falta.

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
