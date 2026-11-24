# Presupuesto familiar

App para seguir el presupuesto familiar desde el móvil y el ordenador:

- **Seguimiento**: un solo panel con:
  - real frente a presupuesto, por mes o acumulado;
  - **previsión de cierre a diciembre**, extrapolada de lo ocurrido;
  - **por qué** se desvían las partidas que más pesan: un cargo puntual, más compras de lo habitual, un ticket más caro, comercios nuevos, goteo de compras pequeñas, desfases de mes (el gasto llegó en otro mes), cobros de más en partidas mensuales o presupuestos poco realistas;
  - mapa de desviaciones por bloque y mes, y detalle por partida.
- **Movimientos**: bandeja de revisión. Cada movimiento sin regla trae una propuesta. Al corregirlo se puede crear una regla, así el mes siguiente ya no hay que tocarlo.
- **Presupuesto**: edición mes a mes. Se puede copiar del año anterior o proponerlo a partir de lo que se gastó de verdad.
- **Ajustes**: carpeta de extractos, procesado diario automático, reglas, partidas e importación desde el Excel anterior.

## La hoja de cálculo es vuestro libro

Todo se guarda en una hoja de Google con **las mismas pestañas y columnas que el Excel original**, y se puede leer y editar a mano:

| Pestaña | Qué es | ¿Se edita a mano? |
|---|---|---|
| `Movimientos` | FECHA, DESCRIPCION, TIPO MVTO, IMPORTE, MES, AÑO, CATEGORIA, CLASIFICACION + estado, nota, regla, saldo… | Sí: cambiar CLASIFICACION la fija a mano; una fila nueva sin ID (p. ej. un gasto en efectivo) se incorpora |
| `Reglas_Categorizacion` | Categoria_regla, Tipología, Clasificación, Comentario_defecto + Signo, Importe_min/max, Meses | Sí |
| `Maestro_Tipologias` | Partidas: Tipología, Clasificación (bloque), Tipo | Sí |
| `FC` | Presupuesto en formato largo (una fila por partida y mes) con IMPORTE ESTIMADO, y el IMPORTE REAL que calcula la app | Sí, IMPORTE ESTIMADO y COMENTARIO |
| `Resumen` | Real, presupuesto y previsión por partida y mes, cierre del año | No: lo reescribe la app |
| `Insights` | Desviaciones principales y sus causas, y el cierre previsto | No: lo reescribe la app |
| `Config`, `Archivos` | Ajustes y ficheros procesados | Mejor desde la app |

La app reescribe las pestañas completas. Haz tus cálculos propios en pestañas aparte, no en columnas añadidas a estas. En la hoja aparece un menú **Presupuesto** para procesar extractos, recalcular o exportar sin abrir la app.

**Copia en Excel.** Desde *Ajustes* (o cada día, si lo activas) se vuelca una copia `.xlsx` de toda la hoja en Drive. Es una foto: lo que se edite en ese `.xlsx` no vuelve a la app. Google no puede editar un `.xlsx` celda a celda, solo sustituirlo entero. Por eso no se usa vuestro `BUDGET_HOME.xlsx` como almacén: perdería el Power Query, las tablas dinámicas y las fórmulas, y si se edita a la vez desde Excel una de las dos versiones se pierde.

## Previsión de cierre

Cada partida se extrapola hasta diciembre con el primer método que aplique:

1. **Estacional**: si hay al menos 6 meses del año anterior, se toma el mismo mes del año pasado × (ritmo de este año / ritmo del pasado). Por ejemplo, el gas de invierno.
2. **Tendencia**: si la partida se mueve casi todos los meses, se toma el presupuesto restante × la mediana de real/presupuesto de los últimos 3 meses. Así se conserva la forma del presupuesto y un cobro extra aislado no la dispara. Sin presupuesto, se usa la mediana de los últimos 3 meses.
3. **Presupuesto**: para gastos esporádicos (IBI, viajes, paga extra), se asume lo que queda presupuestado.

Las proporciones se acotan entre 0,5× y 2×. Lo que está **sin clasificar no se proyecta**: acabará en otras partidas que ya tienen su previsión. Cuanto más clasificado esté, mejor previsión. Para usar el método estacional, deja también los extractos del año anterior en la carpeta.

## Cómo funciona

```
Drive: carpeta de extractos (.xls del banco, subcarpetas por año)
          │  (cada día a las 7:00, o con el botón "Procesar")
          ▼
Apps Script ── lee los ficheros nuevos, descarta los repetidos, aplica las reglas,
          │    propone partida para el resto y comprueba que los saldos cuadran
          ▼
Google Sheet privada (Movimientos, Reglas_Categorizacion, Maestro_Tipologias, FC, Resumen, Insights…)
          ▲
          │
Web app (la misma de Apps Script) ── iPhone / ordenador, cada uno con su cuenta de Google
```

- **Gratis.** Solo usa Google Sheets, Drive y Apps Script.
- **Privado.** Los datos solo están en la hoja. La web app se ejecuta con la cuenta de quien entra, así que solo pueden verla las personas con las que compartáis la hoja. Ningún dato sale de Google: la propuesta de clasificación se calcula localmente, aprendiendo de vuestros movimientos ya clasificados.
- **Este repositorio es público y solo contiene código.** No subas extractos, el Excel ni capturas con datos reales.

### Reglas de clasificación

Cada regla dice "si el concepto contiene X, va a la partida Y". Opcionalmente puede limitarse a gastos o ingresos, a un rango de importes o a unos meses. Por ejemplo, para que la paga extra no entre como nómina: `NOMINA`, meses `6,12`, importe mínimo `2500`.

- Mayúsculas y tildes dan igual: `ASIGNACIÓN` y `ASIGNACION` casan.
- Si casan varias reglas, gana la **más específica** (más condiciones y, después, el texto más largo), no la primera de la lista. Los empates entre partidas distintas se marcan con ⚠.
- Lo que clasificáis a mano no lo vuelve a tocar ninguna regla.
- Lo que no casa con ninguna regla recibe una **propuesta**:
  - Si ese comercio ya se clasificó antes, se usa esa partida.
  - Si no, se compara con las palabras de movimientos parecidos.
  - Como último recurso, se mira el tipo de comercio (farmacia, hotel, supermercado…).
- Si la confianza de la propuesta es de al menos el 60%, cuenta en los totales hasta que la reviséis. Si no, el movimiento queda en «Sin clasificar».

### Integridad

Cada extracto trae el saldo después de cada movimiento. La app comprueba que `saldo anterior + importe = saldo` en toda la cadena. Si se rompe, falta algún movimiento: típicamente un extracto que se descargó antes de que acabara el mes. Basta con volver a descargar ese mes y dejarlo en la carpeta, porque los movimientos repetidos se ignoran.

## Instalación (una vez, unos 15 minutos)

1. **Crea la hoja.** En Google Drive, crea una hoja de cálculo nueva llamada, por ejemplo, *Presupuesto familiar*.
2. **Pega el código.** En la hoja, abre *Extensiones ▸ Apps Script*.
   - Crea un archivo por cada fichero de [`dist/`](dist) y pega su contenido. Los `.js` van como *Secuencia de comandos* (`Code`, `Core`) y los `.html` como *HTML* (`Index`, `Styles`, `App`, `CoreClient`). Borra el `Código.gs` vacío que viene por defecto.
   - En *Configuración del proyecto*, marca *Mostrar el archivo de manifiesto «appsscript.json»* y sustituye su contenido por [`dist/appsscript.json`](dist/appsscript.json). Esto activa el servicio avanzado de Drive, que se usa para leer los `.xls`.
   - Alternativa con terminal: `npm i -g @google/clasp && clasp login`, copia `.clasp.json.example` a `.clasp.json` con el ID del script y ejecuta `npm run push`.
3. **Inicializa.** En el editor, elige la función `setup` y pulsa *Ejecutar*. Google pedirá permisos. Como la app no está "verificada" por Google (es vuestra), saldrá un aviso: *Configuración avanzada ▸ Ir a …*. `setup` crea las pestañas de la hoja.
4. **Publica la web.** *Implementar ▸ Nueva implementación ▸ Aplicación web*:
   - *Ejecutar como*: **Usuario que accede a la aplicación web**
   - *Quién tiene acceso*: **Cualquier usuario con cuenta de Google**. Aun así, solo verán datos quienes tengan la hoja compartida.

   Copia la URL que termina en `/exec`.
5. **Configura** (en la web, pestaña *Ajustes*):
   1. *Carpeta de extractos*: pega el enlace de la carpeta de Drive con los `.xls`.
   2. *Importar desde el Excel*: pega el enlace de `BUDGET_HOME.xlsx`, elige el año y *Reemplazar*. Trae partidas, reglas y presupuesto.
   3. *Procesar extractos ahora*.
   4. *Procesar cada día automáticamente*.
   5. Opcional: *Usuarios permitidos* con vuestros dos emails.
6. **Comparte con tu pareja.** Comparte la **hoja** como editora y la **carpeta de extractos** al menos como lectora. Envíale la URL `/exec`. La primera vez Google le pedirá los mismos permisos.
7. **En el iPhone**: abre la URL en Safari ▸ *Compartir* ▸ *Añadir a pantalla de inicio*.

### Cada mes

1. Descarga el extracto del mes en `.xls` desde la web del banco (también se puede desde la app de Drive del iPhone) y déjalo en la carpeta del año.
2. Al día siguiente estará procesado, o pulsa *Procesar extractos ahora*.
3. En *Movimientos ▸ Por revisar*, acepta las propuestas buenas de golpe y corrige el resto. Marca «crear regla» para lo que se repita.
4. Mira *Seguimiento*. Si una desviación no se explica sola, añade una nota al movimiento (por ejemplo, «avería del coche»): las notas aparecen en la explicación.

### Actualizar el código

Cambia `src/`, ejecuta `npm test` y `npm run build`, y vuelve a pegar o subir los ficheros de `dist/`. Después, en Apps Script: *Implementar ▸ Gestionar implementaciones ▸ Editar ▸ Nueva versión*. La URL no cambia.

## Desarrollo

```
src/core.js      lógica pura (lectura de extractos, reglas, propuestas, agregados, insights). Se usa en servidor y cliente.
src/server.js    Apps Script: hoja, Drive, API para la web, disparador diario
src/*.html       interfaz (HtmlService): Index, Styles, App
scripts/build.js genera dist/ (lo que se sube a Apps Script)
scripts/preview.js  vista previa local con API simulada: node scripts/preview.js [datos.json]
dev/demo-data.js datos 100% inventados para la vista previa
test/            tests (node --test), sin datos reales; test/gas-mock.js simula Apps Script en memoria
                 para ejecutar src/server.js completo (hoja, Drive, importación, informe)
```

```
npm test           # tests del núcleo y coherencia de dist/
npm run preview    # genera dev/preview.html con datos de demo; ábrelo en el navegador
```
