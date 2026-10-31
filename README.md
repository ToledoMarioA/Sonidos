# SeparaVoz

Separador de voz e instrumental **100 % en el navegador**. Sube un MP3 (o WAV/M4A), ejecuta HTDemucs con ONNX Runtime Web y descarga dos archivos:

- `nombre_voz.mp3` — la voz aislada.
- `nombre_instrumental.mp3` — batería + bajo + resto, sin voz.

No hay backend, no se sube audio a ningún servidor y se puede desplegar como sitio estático en GitHub Pages.

## Demo local

```bash
cd separador-voz
python3 -m http.server 8000
# Abre http://localhost:8000
```

El service worker de COOP/COEP necesita `localhost` o HTTPS. En GitHub Pages funciona directamente.

## Desplegar en GitHub Pages

1. Crea un repositorio nuevo (por ejemplo `separador-voz`).
2. Sube **el contenido de esta carpeta** a la raíz del repositorio:
   ```
   index.html
   css/
   js/
   vendor/
   coi-serviceworker.js
   .nojekyll
   ```
3. En GitHub: **Settings → Pages → Build and deployment**.
4. Source: **Deploy from a branch** · Branch: `main` · Folder: `/ (root)`.
5. Espera a que publique y abre `https://TU-USUARIO.github.io/separador-voz/`.

No hace falta build, Node ni Actions. Todo son archivos estáticos.

### ¿Por qué no está el modelo en el repositorio?

El modelo ONNX pesa **180 MB**, por encima del límite de 100 MB por archivo de GitHub Pages. La app lo descarga la primera vez desde Hugging Face y lo guarda en la caché del navegador:

```
https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx
```

Si prefieres autohospedarlo:

1. Sube el `.onnx` a un **GitHub Release** (los assets de Release sí admiten más de 100 MB) o a tu propio almacenamiento con CORS.
2. Abre la app con `?model=https://tu-url/htdemucs_embedded.onnx`.
3. Asegúrate de que la URL devuelve `Access-Control-Allow-Origin: *` y que el archivo se sirve por HTTPS.

## Cómo funciona

1. `decodeAudioData` decodifica el archivo y lo convierte a 44.1 kHz estéreo.
2. HTDemucs procesa la mezcla en segmentos y devuelve 4 fuentes: batería, bajo, resto y voz.
3. La app suma batería + bajo + resto para construir el instrumental y deja la voz aparte.
4. Normaliza ambas pistas y las codifica a MP3 320 kbps (lamejs) o WAV 16 bits.

La inferencia usa **WebGPU** cuando está disponible y cae a **WASM** si no. El modelo se ejecuta en el equipo del usuario: no hay llamadas a una API de separación.

## Rendimiento

En una prueba con una canción de 3:05 y WebGPU (Apple M1) el proceso completo tardó unos 50 segundos, incluyendo la descarga inicial del modelo. Con WASM/CPU es varias veces más lento. La segunda canción es más rápida porque el modelo ya está en caché.

## Requisitos

- Chrome/Edge 113+ o Safari 18+ con WebGPU para una velocidad razonable.
- Sin WebGPU funciona por WASM, pero puede tardar bastante más.
- 4 GB de RAM como mínimo recomendable; mejor 8 GB.
- Conexión a internet la primera vez (modelo de 180 MB).
- Audio de hasta 8 minutos y 80 MB.

## Estructura

```
index.html
css/styles.css
js/app.js           # interfaz y flujo
js/audio.js         # decodificación, WAV/MP3, normalización
js/separator.js     # modelo, sesión ONNX y separación
vendor/demucs-web/  # lógica HTDemucs en JS (MIT)
vendor/ort/         # ONNX Runtime Web + WASM (MIT)
vendor/lame/        # codificador MP3 lamejs
coi-serviceworker.js# COOP/COEP para SharedArrayBuffer en Pages (MIT)
```

## Limitaciones y notas

- La separación no es perfecta: reverberación, coros, voces al centro mezcladas con instrumentos o grabaciones monofónicas pueden dejar restos.
- El modelo se descarga una vez; si el navegador borra la caché, se vuelve a descargar.
- La primera inferencia incluye la compilación del modelo en GPU y puede tardar más.
- En móviles con poca memoria el navegador puede cerrar la pestaña; usa un ordenador para canciones completas.
- No se sube ninguna canción. Solo se descarga el modelo desde Hugging Face.

## Licencia

El código de SeparaVoz se publica bajo licencia MIT (ver `LICENSE`). Las dependencias y el modelo tienen sus propias licencias; consulta `THIRD_PARTY_NOTICES.md`.

## Créditos y licencias

- **HTDemucs** / Demucs — Meta AI Research, MIT.
- **demucs-web** de [timcsy](https://github.com/timcsy/demucs-web) — MIT; adaptación de la inferencia HTDemucs a ONNX Runtime Web.
- **ONNX Runtime Web** — Microsoft, MIT.
- **lamejs** — LGPL; se incluye el build minificado para codificar MP3 en el navegador.
- **coi-serviceworker** de Guido Zuidhof — MIT.
- Modelo ONNX: [timcsy/demucs-web-onnx](https://huggingface.co/timcsy/demucs-web-onnx). Consulta la licencia del modelo antes de usarlo comercialmente.

Los derechos de las canciones siguen siendo de sus autores. Usa la herramienta solo con audio que tengas derecho a procesar.
