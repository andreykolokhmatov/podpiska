# Кнопка «Deploy with Vercel»

Кнопка в README собрана по документации Vercel:
[Deploy Button](https://vercel.com/docs/deploy-button),
[параметры источника и `stores`](https://vercel.com/docs/deploy-button/source),
[переменные окружения](https://vercel.com/docs/deploy-button/environment-variables).

## Параметры

| Параметр          | Значение                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `repository-url`  | `https://github.com/andreykolokhmatov/podpiska`                                                                  |
| `project-name`    | `podpiska`                                                                                                       |
| `repository-name` | `podpiska`                                                                                                       |
| `env`             | `TELEGRAM_BOT_TOKEN,GOOGLE_GENERATIVE_AI_API_KEY,OWNER_TELEGRAM_ID`                                              |
| `envDescription`  | `Токен бота из @BotFather, ключ Gemini из aistudio.google.com/apikey и ваш числовой Telegram id из @userinfobot` |
| `envLink`         | `https://github.com/andreykolokhmatov/podpiska#deploy-env` (якорь `<a id="deploy-env">` в README)                |
| `stores`          | JSON ниже, через `encodeURIComponent`                                                                            |

`stores` (интеграция Neon из Vercel Marketplace):

```json
[
  {
    "type": "integration",
    "integrationSlug": "neon",
    "productSlug": "neon",
    "protocol": "storage"
  }
]
```

Остальные переменные (`APP_URL`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`) вычисляются в коде
(`src/lib/env.ts`), их в `env` нет специально: чем меньше полей в форме, тем меньше ошибок.

## Как пересобрать URL

```sh
node --input-type=module -e "
const e = encodeURIComponent;
const stores = [{ type: 'integration', integrationSlug: 'neon', productSlug: 'neon', protocol: 'storage' }];
console.log('https://vercel.com/new/clone'
  + '?repository-url=' + e('https://github.com/andreykolokhmatov/podpiska')
  + '&project-name=podpiska&repository-name=podpiska'
  + '&env=TELEGRAM_BOT_TOKEN,GOOGLE_GENERATIVE_AI_API_KEY,OWNER_TELEGRAM_ID'
  + '&envDescription=' + e('Токен бота из @BotFather, ключ Gemini из aistudio.google.com/apikey и ваш числовой Telegram id из @userinfobot')
  + '&envLink=' + e('https://github.com/andreykolokhmatov/podpiska#deploy-env')
  + '&stores=' + e(JSON.stringify(stores)));
"
```

Результат вставить в README в ссылку вокруг `https://vercel.com/button`.

## Проверить вживую

- [ ] Слаги `integrationSlug: "neon"` / `productSlug: "neon"` – взяты по аналогии с шаблонами Vercel,
      в документации только пример с выдуманными слагами. Убедиться, что форма предлагает создать базу Neon.
- [ ] Neon-интеграция кладёт `DATABASE_URL` **и** `DATABASE_URL_UNPOOLED` до первого билда
      (иначе `pnpm release` упадёт или пойдёт через pooled-хост – в логе будет предупреждение).
- [ ] В форме создания базы можно выбрать регион Frankfurt (`aws-eu-central-1`).
- [ ] `envDescription` на русском отображается нормально, `envLink` с якорем `#deploy-env` открывает нужный раздел.
- [ ] В логе первого production-билда есть `migrations: … applied` и `bot configured`.
