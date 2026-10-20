# RichText v2 и Block Document v1

Владелец: Core Content, Blocks и Web renderer. Это независимые форматы с независимыми версиями. Формат определяется effective Content Type и объявленным типом поля, а не видом JSON.

```json
{"blocks":[],"schema_version":1}
```

Это корректный пустой Block Document, а не RichText v1. Его нельзя «обновлять» простой заменой версии на 2. RichText выглядит иначе:

```json
{"type":"document","schema_version":2,"content":[{"type":"paragraph","content":[{"type":"text","text":"Пример"}]}]}
```

`bodyPolicy: rich_text` хранит текст в объявленных RichText-полях; непустые скрытые payload.blocks новой WORKING-ревизии запрещены. `bodyPolicy: block_document` использует зарегистрированные typed blocks. Каждый вложенный RichText-документ имеет собственный schema_version: 2. Таблицы рендерит Core, специальный шаблон темы не нужен.

Пустое необязательное тело допустимо. Web обрабатывает Block Document отдельным декодером и не направляет его в strict RichText reader. Значение block_document-поля пока не проходит отдельную повторную проверку дерева; для payload.blocks она выполняется. Не обещайте более строгую проверку как реализованную.

Рабочие примеры: [RichText с таблицей](../reference/examples/richtext-v2-table.json), [typed blocks](../reference/examples/block-document-v1.json), [Content Types](../reference/examples/content-types.json). Полный [контракт на английском](../content-contract.md).

[Русский индекс](index.md)
