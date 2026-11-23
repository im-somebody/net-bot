# Net-Bot

Extensión de Chrome para NetAcad que recorre el curso por ti, prepara tus apuntes de cada página y resuelve los exámenes.

## Qué hace

- **Recorrer el curso y guardar apuntes:** avanza página por página y guarda un archivo `.md` por cada una en `Descargas/ccna/`. Opcionalmente antepone un resumen hecho con IA.
- **Recorrer quizzes:** contesta los quizzes, confirma el envío y guarda el resultado. No necesita IA: hace un primer intento en blanco para leer las respuestas correctas y luego contesta con ellas. La IA solo se usa como respaldo si hay una API key.
- **Explicar esta página:** explica solo la página actual, sin avanzar.
- **Diagnóstico:** genera un reporte de la página para depurar problemas.

## Instalación

1. Descarga o clona este repositorio.
2. Abre `chrome://extensions` y activa el **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta del repositorio.

## Uso

1. Abre la lección en NetAcad y recarga la página (F5).
2. Abre Net-Bot desde la barra del navegador.
3. En **Ajustes**, elige el proveedor de IA (Venice, Gemini o Claude) y pega tu API key. Usa **Probar la key** para comprobarla.
4. Pulsa la acción que quieras. Usa **Detener** para pararla en cualquier momento.

Solo **Explicar esta página** y el resumen de los apuntes necesitan una API key. Los apuntes y los quizzes funcionan sin ella.
