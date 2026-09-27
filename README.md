# 📺 IPTV Costa Rica

Reproductor web de los canales de televisión de Costa Rica que publica
[iptv-org](https://github.com/iptv-org/iptv), con **proxy HLS propio**, **guía de
programas (EPG)**, **comprobación de disponibilidad** y **selección automática de
calidad**.

Sin dependencias de npm: sólo Node.js 20+ y [hls.js](https://github.com/video-dev/hls.js)
(vendored).

---

## ¿Por qué hace falta un proxy?

Casi ninguno de los servidores HLS de iptv-org envía cabeceras `Access-Control-Allow-Origin`.
Un `<video src="https://servidor-real/stream.m3u8">` directo desde el navegador falla por CORS
en la mayoría de los canales. El servidor Node hace de intermediario:

1. El navegador pide `/hls?u=<url-base64>`.
2. El servidor valida el host destino, descarga el manifiesto y **reescribe todas las URLs
   internas** (variantes, segmentos, claves, subtítulos) para que vuelvan a pasar por el proxy.
3. Los segmentos `.ts` se transmiten tal cual, sin procesarlos.

Ventaja extra: se pueden seguir los *redirects* de CDN (muchos streams redirigen
`azulstream.com` → `azulstreams.com`) porque cada salto se valida por separado.

---

## Puesta en marcha

```bash
node --version        # hace falta >= 20
npm start             # http://localhost:8080
```

No hay `npm install`: el proyecto no tiene dependencias. Al arrancar por primera vez
descarga la lista de canales y la guía EPG, y las cachea en `data/`.

Other scripts:

```bash
npm run dev          # recarga el servidor al guardar (node --watch)
npm test             # 19 tests con node:test
npm run probe        # comprueba qué canales responden ahora mismo
npm run probe -- --deep --json
npm run vendor:hls   # vuelve a descargar public/vendor/hls.min.js desde el CDN
```

Para usar otro puerto:

```bash
PORT=8090 npm start
```

---

## Funciones

| | |
|---|---|
| **Rejilla de canales** | logo, número, nombre, categoría y etiquetas (`SD`/`HD`, `GEO`, `24/7`) |
| **EPG** | programa en curso + línea de tiempo del día, con la hora de Costa Rica |
| **Filtro por categoría** | las categorías de iptv-org se traducen al español |
| **Búsqueda** | por nombre, categoría (español o inglés) o `tvg-id` |
| **Favoritos** | se guardan en `localStorage`, sobreviven a las recargas |
| **Comprobación de canales** | marca los caídos con `CAÍDO` y permite ocultarlos |
| **Calidad automática** | eligen la mejor variante según el ancho de banda; también se puede fijar a mano |
| **Atajos de teclado** | ver más abajo |

### Atajos de teclado

Siempre disponibles:

| Tecla | Acción |
|---|---|
| `/` | ir al buscador |
| `Enter` | abrir el primer canal del filtro actual |
| `Esc` | cerrar la ayuda o el reproductor |

Con el reproductor abierto:

| Tecla | Acción |
|---|---|
| `←` / `→` | canal anterior / siguiente |
| `Espacio` | reproducir / pausar |
| `m` | silenciar |
| `f` | pantalla completa |
| `p` | imagen en imagen (PiP) |
| `s` | añadir o quitar de favoritos |
| `g` | ir a favoritos |

---

## Configuración (`config.json`)

```jsonc
{
  "server":    { "port": 8080, "host": "0.0.0.0" },
  "playlist":  { "url": "…/cr.m3u", "cacheMinutes": 180 },
  "epg":       { "sources": [ … ], "cacheHours": 6, "fuzzyMatch": true, "minFuzzyScore": 0.75 },
  "proxy":     { "timeoutMs": 15000, "policy": "public", "allowAnyHost": false, "extraAllowedHosts": [] },
  "probe":     { "timeoutMs": 9000, "concurrency": 6, "cacheMinutes": 10, "deep": true }
}
```

`PORT` y `HOST` en el entorno tienen prioridad sobre `config.json`.

### Política del proxy

- **`"public"`** (por defecto) — se permite cualquier host **público**. Los redirects de CDN
  funcionan sin intervención. Las IPs privadas, de loopback y reservadas se bloquean siempre,
  resolviendo el DNS antes de cada petición (con caché).
- **`"playlist"`** — sólo los hosts que aparecen en la lista. Cuando un stream redirige fuera,
  la interfaz ofrece aprobarlo con un botón; la aprobación se guarda en
  `proxy.extraAllowedHosts`.
- **`"allowAnyHost": true`** — desactiva las restricciones. **Úsalo sólo en una red de confianza.**

En ambos modos se rechazan siempre los rangos privados (`10/8`, `192.168/16`, `127/8`,
`169.254/16`, IPv6 link-local y unique-local, etc.), de modo que el proxy no puede usarse
para alcanzar servicios internos.

---

## API

| Ruta | Qué hace |
|---|---|
| `GET /api/health` | estado del servidor, nº de canales, estado del EPG |
| `GET /api/channels` | canales + `groups` con etiqueta traducida y contador |
| `GET /api/epg` | guía completa (canales enlazados + cobertura) |
| `GET /api/epg/<channelId>` | línea de tiempo de un canal |
| `POST /api/epg/refresh` | fuerza la descarga del XMLTV |
| `POST /api/playlist/refresh` | fuerza la descarga de la M3U |
| `GET /api/check` | comprueba la disponibilidad; `?ids=a,b` y `?deep=1` para limitar |
| `POST /api/allow-host` | `{ "host": "…", "persist": true }` — aprueba un host |
| `GET /hls?u=<base64url>` | manifiesto reescrito o segmento transmitido |
| `GET /img?u=<url-encoded>` | logo remoto servido con CORS abierto |

---

## Estructura

```
server/
  index.js        servidor HTTP, rutas, proxy principal
  config.js       carga/validación de config.json
  log.js          logging con color
  http-client.js  HostGuard (SSRF), fetchFollow con validación por salto
  m3u.js          parser M3U + traducción de categorías
  playlist.js     descarga y cache en disco
  epg.js          parser XMLTV (gzip) y emparejado difuso con la M3U
  proxy.js        reescritura de manifiestos, checkChannel, utilidades
  static.js       ficheros estáticos y proxy de imágenes
public/
  index.html      interfaz (sin framework)
  css/styles.css
  js/app.js       rejilla, filtros, búsqueda, atajos
  js/player.js    hls.js, calidades, línea de tiempo EPG
  js/{api,store,util}.js
  vendor/hls.min.js
scripts/
  test.js         19 tests
  probe.js        comprobador de canales por CLI
  vendor-hls.js   descarga hls.js
```

---

## Sobre la EPG

iptv-org ya no publica XMLTV pregenerado, así que la guía se toma de
**iptv-epg.org**, filtrada a Costa Rica: `https://iptv-epg.org/files/epg-cr.xml.gz`
(84 canales, ~11 000 programas, una semana de cobertura). Se cachea descomprimida en
`data/epg/` durante `epg.cacheHours`.

El emparejado es difuso (`epg.fuzzyMatch`) con un umbral mínimo
(`epg.minFuzzyScore`, 0.75 por defecto) y **protección contra ambigüedad**: si dos
canales de la guía puntúan igual de bien, no se asigna ninguno. En la práctica enlaza
unos **5 de los 65 canales** de la lista, porque la M3U es sobre todo de canales
locales pequeños y la guía es de cable internacional. Los que no enlazan muestran
*«Sin guía disponible»*. Para cambiar de proveedor, edita `epg.sources` en
`config.json` (se pueden listar varias; se usan todas).

Las horas se muestran en `America/Costa_Rica` independientemente de la zona horaria
del navegador.

---

## Notas

- **Sin señal ≠ canal malo.** La comprobación marca `CAÍDO` cuando el stream no
  responde o devuelve un segmento vacío. Muchos canales son *geo-blocked* (`GEO`) o
  sólo emiten en ciertas franjas horarias, así que un canal marcado como caído a
  las 3 de la mañana puede funcionar perfectamente a las 8.
- **Latencia de la red.** Si el equipo va justo de ancho de banda, la carga de
  segmentos se ralentiza y el vídeo se queda en *«Buffering…»*. El proxy transmite
  sin transformar, así que la calidad viene limitada por tu conexión, no por el
  servidor.
- **Legal.** Este proyecto no aloja ni emite ningún canal: sólo reutiliza las URLs
  públicas de iptv-org y añade un proxy para sortear CORS. Varios de esos streams son
  capturas de canales de pago y su visión puede ser ilegal en tu país. Úsalo solo
  con fines personales o educativos, con el contenido al que tengas derecho, y
  respeta la normativa local.
