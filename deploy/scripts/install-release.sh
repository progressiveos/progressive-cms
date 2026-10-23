#!/usr/bin/env bash
# Progressive CMS — единый установщик: первичная установка И обновление.
# PCMS-INSTALLER:5
#
# Один скрипт на все фазы жизни инстанса; режим определяется сам:
#
#   1. BOOTSTRAP — /etc/progressive-cms/pcms.json отсутствует.
#      Готовит хост (пакеты, Node 24, PostgreSQL опционально, systemd-юниты,
#      polkit, конфиг, секреты), ставит релиз из артефакта, выполняет
#      миграции, создаёт владельца, привязывает первичный домен, запускает
#      doctor. Требует root.
#        * человек за терминалом: интерактивный мастер (вопросы с дефолтами);
#        * агент/скрипт: тихий режим — все параметры флагами + --yes.
#   2. UPDATE — конфиг существует, запуск вручную (root, вне systemd-юнита).
#      Ставит артефакт из incoming/ (или --artifact), выполняет миграции
#      НОВОГО релиза, перезапускает web+worker, запускает doctor.
#   3. ORCHESTRATED — вызов юнитом progressive-cms-install.service
#      (ExecStart всегда ровно `--from-incoming`; отличие от ручного запуска —
#      заданный systemd'ом $INVOCATION_ID): только проверка/распаковка/
#      активация артефакта и self-refresh пина. Миграции/рестарты/doctor —
#      зона оркестратора (`cms update apply` / apply-update из реестра).
#   4. --pg-setup-only — подготовить ТОЛЬКО PostgreSQL (отдельный хост БД).
#
# Артефакт: progressive-cms-<release-id>.zip (+ .sha256) — immutable
# releases/<id>/ + атомарный симлинк current; retention: current + previous.
# Скрипт никогда не мутирует установленный релиз и не трогает медиа.
#
# Флаги (тихий режим; интерактивный мастер спрашивает то же самое):
#   --site-host ИМЯ          публичный домен сайта
#   --profile РЕЖИМ          local-nginx (VDS, nginx здесь; TLS = certbot)
#                            | external-rp (внешний reverse-proxy, nginx нет)
#   --http-host АДРЕС        что слушает web (обязателен для external-rp)
#   --trusted-proxy-edge АДРЕС|CIDR  доверенный reverse proxy peer
#                            (ОБЯЗАТЕЛЕН для external-rp; для local-nginx —
#                            127.0.0.1). Для external-rp адрес обязателен.
#   --pg local|remote        поставить PostgreSQL здесь | внешний готовый
#   --db-host/--db-port/--db-name/--db-user/--db-owner
#   --db-password-file ФАЙЛ  пароль пользователя БД (читается и удаляется);
#                            для local не задан — генерируется
#   --client-address АДРЕС   (только --pg-setup-only) адрес хоста приложения
#   --admin-email АДРЕС      владелец админки (по умолчанию owner@<site-host>)
#   --artifact ФАЙЛ.zip      релизный артефакт (иначе берётся из incoming/)
#   --registry-url URL       реестр артефактов (по умолчанию
#                            https://my.p-cms.ru — one-click обновления)
#   --registry-token-file Ф  токен гражданина реестра (файл читается и
#                            удаляется; без него one-click заработает после
#                            добавления секрета registry.token)
#   --assets-dir КАТАЛОГ     каталог deploy/ (по умолчанию — рядом со скриптом)
#   --without-restart-bridge не ставить мост рестарта
#   --yes                    тихий режим без вопросов
#   --from-incoming          явный источник: incoming/ (для --expect-* вручную)
#   --expect-version/--expect-rollback-policy — сверка цели (ручная поставка)
#
# Примеры:
#   sudo ./install-release.sh                       # интерактивный мастер
#   sudo ./install-release.sh --yes --site-host site.example.com --pg local \
#     --profile external-rp --http-host 192.0.2.10 \
#     --trusted-proxy-edge 198.51.100.7 \
#     --artifact /root/progressive-cms-<release-id>.zip
#   sudo ./install-release.sh                       # обновление (новейший из incoming/)
#   sudo ./install-release.sh --artifact /root/progressive-cms-...zip
set -euo pipefail

PREFIX=/opt/progressive-cms
INCOMING=$PREFIX/incoming
RELEASES=$PREFIX/releases
CURRENT=$PREFIX/current
ETC=/etc/progressive-cms
SECRETS=$ETC/secrets
STATEROOT=/var/lib/progressive-cms
RUNDIR=/run/progressive-cms
PIN_DIR=/usr/local/lib/pcms
CONFIG=$ETC/pcms.json
SERVICE_USER=progressive-cms
WEB_PORT=3000

SCRIPT_PATH=$(readlink -f "$0")
SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd)
ASSETS=${ASSETS_DIR:-$SCRIPT_DIR/..}

log() { printf '[pcms-install] %s\n' "$*"; }
die() { printf '[pcms-install] ERROR: %s\n' "$*" >&2; exit 1; }

normalize_release_permissions() { # $1 = installed immutable release tree
  [ "$(id -u)" = 0 ] || die "установка релиза требует root для владельца root:$SERVICE_USER"
  # Keep group access predictable, including older ZIPs without directory entries.
  chown -R "root:$SERVICE_USER" -- "$1"
  find "$1" -type d -exec chmod 750 {} +
  find "$1" -type f -perm /111 -exec chmod 750 {} +
  find "$1" -type f ! -perm /111 -exec chmod 640 {} +
}

verify_release_access() { # root probes as the actual runtime user before activation
  runuser -u "$SERVICE_USER" -- sh -c '
    root=$1
    cd "$root" || exit 1
    for file in build-metadata.json apps/web/src/main.js apps/worker/src/main.js apps/admin/dist/index.html; do
      test -r "$root/$file" || { echo "unreadable runtime file: $file" >&2; exit 1; }
    done
    inaccessible=$(find "$root" \( -type f ! -readable -o -type d ! -executable \) -print -quit) || exit 1
    test -z "$inaccessible" || { echo "inaccessible runtime path: $inaccessible" >&2; exit 1; }
  ' verify-release "$1" || die "runtime недоступен пользователю $SERVICE_USER; current не изменён"
}

rollback_failed_deployment() {
  local request previous target current
  [ -f "$INCOMING/rollback-deployment.json" ] && [ ! -L "$INCOMING/rollback-deployment.json" ] || die "rollback deployment: request должен быть обычным файлом"
  request=$(cat "$INCOMING/rollback-deployment.json")
  rm -f "$INCOMING/rollback-deployment.json"
  previous=$(jq -er '.previous | select(type == "string" and length > 0)' "$PIN_DIR/deployment.json")
  target=$(jq -er '.target | select(type == "string" and length > 0)' "$PIN_DIR/deployment.json")
  current=$(readlink -f "$CURRENT")
  [ "$(printf '%s' "$request" | jq -er .previous)" = "$previous" ] &&
    [ "$(printf '%s' "$request" | jq -er .target)" = "$target" ] &&
    [ "$current" = "$target" ] || die "rollback deployment: receipt/CAS mismatch"
  case "$previous" in "$RELEASES"/*) ;; *) die "rollback deployment: previous вне releases" ;; esac
  [ -d "$previous" ] && [ ! -L "$previous" ] || die "rollback deployment: previous отсутствует"
  verify_release_access "$previous"
  ln -sfn "$previous" "$CURRENT.tmp" && mv -T "$CURRENT.tmp" "$CURRENT"
  rm -f "$PIN_DIR/deployment.json"
  log "неуспешный deployment отменён: $previous (миграции ещё не запускались)"
}

# Маркер версии логики: self-refresh пина происходит только когда копия из
# свежего релиза несёт маркер НЕ ниже исполняющегося скрипта. grep, а не awk:
# awk без совпадений выходит с кодом 0 и пустым выводом (|| echo 0 не сработал бы).
marker_version() { grep -m1 -o 'PCMS-INSTALLER:[0-9]\+' "$1" 2>/dev/null | cut -d: -f2 || echo 0; }
SELF_VERSION=$(marker_version "$SCRIPT_PATH")

# ---------- аргументы --------------------------------------------------------
OPT_SITE_HOST= OPT_PROFILE= OPT_HTTP_HOST= OPT_TRUSTED_PROXY_EDGE=
OPT_PG= OPT_DB_HOST= OPT_DB_PORT=5432 OPT_DB_NAME= OPT_DB_USER= OPT_DB_OWNER=
OPT_DB_PASSWORD_FILE= OPT_ADMIN_EMAIL= OPT_ARTIFACT= OPT_CLIENT_ADDRESS=
OPT_EXPECT_VERSION= OPT_EXPECT_POLICY= OPT_FROM_INCOMING=0
OPT_REGISTRY_URL= OPT_REGISTRY_TOKEN_FILE=
OPT_YES=0 OPT_NO_BRIDGE=0 OPT_PG_SETUP_ONLY=0

usage() { sed -n '/^# Флаги/,/^# Примеры/p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --site-host) OPT_SITE_HOST=$2; shift 2 ;;
    --profile) OPT_PROFILE=$2; shift 2 ;;
    --http-host) OPT_HTTP_HOST=$2; shift 2 ;;
    --trusted-proxy-edge) OPT_TRUSTED_PROXY_EDGE=$2; shift 2 ;;
    --pg) OPT_PG=$2; shift 2 ;;
    --db-host) OPT_DB_HOST=$2; shift 2 ;;
    --db-port) OPT_DB_PORT=$2; shift 2 ;;
    --db-name) OPT_DB_NAME=$2; shift 2 ;;
    --db-user) OPT_DB_USER=$2; shift 2 ;;
    --db-owner) OPT_DB_OWNER=$2; shift 2 ;;
    --db-password-file) OPT_DB_PASSWORD_FILE=$2; shift 2 ;;
    --client-address) OPT_CLIENT_ADDRESS=$2; shift 2 ;;
    --admin-email) OPT_ADMIN_EMAIL=$2; shift 2 ;;
    --artifact) OPT_ARTIFACT=$2; shift 2 ;;
    --registry-url) OPT_REGISTRY_URL=$2; shift 2 ;;
    --registry-token-file) OPT_REGISTRY_TOKEN_FILE=$2; shift 2 ;;
    --assets-dir) ASSETS=$2; shift 2 ;;
    --from-incoming) OPT_FROM_INCOMING=1; shift 1 ;;
    --expect-version) OPT_EXPECT_VERSION=$2; shift 2 ;;
    --expect-rollback-policy) OPT_EXPECT_POLICY=$2; shift 2 ;;
    --pg-setup-only) OPT_PG_SETUP_ONLY=1; shift 1 ;;
    --without-restart-bridge) OPT_NO_BRIDGE=1; shift 1 ;;
    --yes|--non-interactive) OPT_YES=1; shift 1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1 (см. --help)" >&2; exit 2 ;;
  esac
done

INTERACTIVE=0
if [ -t 0 ] && [ -t 1 ] && [ "$OPT_YES" = 0 ]; then INTERACTIVE=1; fi

# ---------- интерактивные помощники ------------------------------------------
ask() { # ask VAR PROMPT DEFAULT VALIDATOR VALIDATOR_DESC
  local __var=$1 __prompt=$2 __def=${3-} __validator=${4-} __vdesc=${5-непусто} __reply
  while :; do
    printf '%s' "$__prompt"
    [ -n "$__def" ] && printf ' [%s]' "$__def"
    printf ': '
    IFS= read -r __reply
    __reply=${__reply:-$__def}
    if [ -n "$__reply" ] && [ -n "$__validator" ] && ! "$__validator" "$__reply"; then
      printf '  (некорректно: ожидалось %s)\n' "$__vdesc" >&2
      continue
    fi
    [ -n "$__reply" ] || { printf '  (значение обязательно)\n' >&2; continue; }
    printf -v "$__var" '%s' "$__reply"
    return 0
  done
}

ask_choice() { # ask_choice VAR PROMPT DEFAULT OPTION...
  local __var=$1 __prompt=$2 __def=$3; shift 3
  local __opts=("$@") __i __reply
  while :; do
    printf '%s\n' "$__prompt"
    __i=1
    for __opt in "${__opts[@]}"; do
      printf '  %d) %s' "$__i" "$__opt"
      [ "$__opt" = "$__def" ] && printf '  (по умолчанию)'
      printf '\n'
      __i=$((__i + 1))
    done
    printf 'Выбор [%s]: ' "$__def"
    IFS= read -r __reply
    __reply=${__reply:-$__def}
    case "$__reply" in
      ''|*[!0-9]*) printf -v "$__var" '%s' "$__reply"; return 0 ;;
      *) if [ "$__reply" -ge 1 ] && [ "$__reply" -le "${#__opts[@]}" ]; then
           printf -v "$__var" '%s' "${__opts[$((__reply - 1))]}"
           return 0
         fi ;;
    esac
    printf '  (нет такого варианта)\n' >&2
  done
}

valid_hostname() { printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'; }
valid_path() { [ -e "$1" ]; }
valid_ip() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }

# Доверенный proxy edge: одиночный IPv4/IPv6-адрес или CIDR. Wildcard запрещён:
# http.trustedProxies решает, каким X-Forwarded-* верить, «доверять всем» = спуфинг Origin.
# ponytail: IPv6 без строгого парсинга octet-групп; мусор отсеет конфиг-валидация web при старте.
valid_proxy_addr() {
  case "$1" in
    */0 | 0.0.0.0 | ::) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(/(3[0-2]|[12][0-9]|[0-9]))?$' && return 0
  printf '%s' "$1" | grep -Eq '^[0-9A-Fa-f:]+(/[0-9]{1,3})?$' && return 0
  return 1
}

# Без upstream-|-head: завершающий cut читает весь ввод — никакого SIGPIPE
# при pipefail (tr после закрывшегося head убил бы пайплайн с 141).
random_password() { head -c 256 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32; }

# ---------- PostgreSQL (общая для bootstrap и --pg-setup-only) ----------------
select_pg_cluster() { # $1=requested port
  local -a matches
  mapfile -t matches < <(pg_lsclusters --no-header | awk -v port="$1" '$3 == port { print $1 " " $2 }')
  [ "${#matches[@]}" -eq 1 ] || die "PostgreSQL: expected one cluster on port $1, found ${#matches[@]} (pg_lsclusters)"
  printf '%s\n' "${matches[0]}"
}

pg_provision() { # $1=db $2=owner $3=app_user $4=client_cidr $5=password
  local db=$1 owner=$2 appuser=$3 client=$4 pw=$5 PG_MAJOR PG_CLUSTER PG_UNIT HBA RULE
  # psql alone does not prove a server exists; choose the actual cluster by port.
  if [ -z "$(ls /etc/postgresql 2>/dev/null || true)" ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib >/dev/null
  fi
  read -r PG_MAJOR PG_CLUSTER < <(select_pg_cluster "$OPT_DB_PORT")
  [ -n "$PG_MAJOR" ] && [ -n "$PG_CLUSTER" ] || die "PostgreSQL cluster selection failed"
  PG_UNIT="postgresql@${PG_MAJOR}-${PG_CLUSTER}"
  HBA="/etc/postgresql/${PG_MAJOR}/${PG_CLUSTER}/pg_hba.conf"
  systemctl enable --quiet "$PG_UNIT" 2>/dev/null || true
  systemctl start "$PG_UNIT"
  # psql-интерполяция :'var' не работает внутри dollar-quoted DO-блоков
  # (проверено на PG18/26.04) — подставляем shell'ом, кавычки удваиваем.
  sql_literal() { printf '%s' "$1" | sed "s/'/''/g"; }
  local owner_l app_l pw_l
  owner_l=$(sql_literal "$owner"); app_l=$(sql_literal "$appuser"); pw_l=$(sql_literal "$pw")
  runuser -u postgres -- psql -p "$OPT_DB_PORT" -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$owner_l') THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', '$owner_l');
  END IF;
END \$\$;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$app_l') THEN
    EXECUTE format('CREATE ROLE %I LOGIN', '$app_l');
  END IF;
END \$\$;
SET password_encryption = 'scram-sha-256';
ALTER ROLE "$app_l" PASSWORD '$pw_l';
ALTER ROLE "$app_l" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SQL
  unset owner_l app_l pw_l
  if ! runuser -u postgres -- psql -p "$OPT_DB_PORT" -Atqc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    runuser -u postgres -- createdb -p "$OPT_DB_PORT" -O "$owner" "$db"
    log "база ${db} создана (владелец ${owner})"
  fi
  runuser -u postgres -- psql -p "$OPT_DB_PORT" -v ON_ERROR_STOP=1 -d "$db" >/dev/null <<SQL
REVOKE ALL ON DATABASE "${db}" FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE "${db}" TO "${appuser}";
-- CREATE на базе нужен app-роли для trusted-расширений (pg_trgm, миграция 1712+)
GRANT CREATE ON DATABASE "${db}" TO "${appuser}";
ALTER SCHEMA public OWNER TO "${owner}";
GRANT USAGE, CREATE ON SCHEMA public TO "${appuser}";
SQL
  RULE="host ${db} ${appuser} ${client} scram-sha-256"
  if ! grep -qF "$RULE" "$HBA"; then
    cat >> "$HBA" <<RULES

# progressive-cms ${db} application role (single allowed client)
${RULE}
RULES
  fi
  systemctl restart "$PG_UNIT"
  systemctl is-active --quiet "$PG_UNIT"
  log "pg_hba: ${client} -> ${db}/${appuser} (scram-sha-256)"
}

if [ "$OPT_PG_SETUP_ONLY" = 1 ]; then
  [ "$(id -u)" = 0 ] || die "--pg-setup-only требует root"
  [ -n "$OPT_DB_NAME" ] && [ -n "$OPT_DB_USER" ] && [ -n "$OPT_CLIENT_ADDRESS" ] || \
    die "--pg-setup-only: нужны --db-name --db-user --client-address (адрес хоста приложения)"
  [ -n "$OPT_DB_PASSWORD_FILE" ] || die "--pg-setup-only: нужен --db-password-file (пароль файлом, не argv)"
  PW=$(cat "$OPT_DB_PASSWORD_FILE"); rm -f "$OPT_DB_PASSWORD_FILE"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  pg_provision "$OPT_DB_NAME" "${OPT_DB_OWNER:-${OPT_DB_USER}_owner}" "$OPT_DB_USER" \
    "${OPT_CLIENT_ADDRESS}/32" "$PW"
  unset PW
  log "PostgreSQL готов; на хосте приложения запустите установку с --pg remote"
  exit 0
fi

install_from_incoming() ( # $1 = требовать ли целевой манифест (1 — только юнит)
  local require_manifest=$1 expect_version=$OPT_EXPECT_VERSION expect_policy=$OPT_EXPECT_POLICY
  [ -d "$INCOMING" ] || die "нет каталога: $INCOMING"
  # Normalize ownership and permissions before staging an artifact.
  if [ "$(id -u)" = "0" ]; then
    chown -R progressive-cms:progressive-cms "$INCOMING" 2>/dev/null || true
    chown root:progressive-cms "$INCOMING" 2>/dev/null || true
    chmod 2775 "$INCOMING" 2>/dev/null || true
  fi
  if [ "$require_manifest" = 1 ] && [ -z "$expect_version" ]; then
    [ -f "$INCOMING/update-manifest.json" ] || die "нет целевого манифеста: $INCOMING/update-manifest.json"
    expect_version=$(jq -r .version "$INCOMING/update-manifest.json")
    expect_policy=$(jq -r .rollback_policy "$INCOMING/update-manifest.json")
  fi

  # Keep the two newest release archives and remove stale temporary files.
  if [ "$(id -u)" = "0" ]; then
    find "$INCOMING" -maxdepth 1 -name '*.zip' -type f | sort -r | tail -n +3 | while read -r stale; do
      rm -f "$stale" "$stale.sha256"
      log "уборка incoming/: удалён $stale (ретеншен — два новейших zip)"
    done
    find "$INCOMING" -maxdepth 1 -type f ! -name '*.zip' ! -name '*.zip.sha256' ! -name 'update-manifest.json' -mtime +30 -delete 2>/dev/null || true
  fi

  local matched= matched_count=0 artifact listing manifest_member embedded embedded_policy
  for artifact in "$INCOMING"/*.zip; do
    [ -e "$artifact" ] || continue
    if [ -f "$artifact.sha256" ]; then
      (cd "$(dirname "$artifact")" && sha256sum -c "$(basename "$artifact").sha256" --quiet)
    else
      # An archive without a checksum cannot be installed safely.
      log "ПРЕДУПРЕЖДЕНИЕ: пропущен $artifact — нет .sha256 рядом (не будет установлен)"
      continue
    fi
    listing=$(unzip -Z1 "$artifact")
    manifest_member=$(printf '%s\n' "$listing" | grep '[^/]*/update-manifest.json$' | head -1)
    [ -n "$manifest_member" ] || die "в артефакте нет update-manifest.json: $artifact"
    embedded=$(unzip -p "$artifact" "$manifest_member" | jq -r .version 2>/dev/null || echo "")
    if [ -n "$expect_version" ]; then
      embedded_policy=$(unzip -p "$artifact" "$manifest_member" | jq -r .rollback_policy 2>/dev/null || echo "")
      if [ "$embedded" = "$expect_version" ] && { [ -z "$expect_policy" ] || [ "$embedded_policy" = "$expect_policy" ]; }; then
        matched=$artifact; matched_count=$((matched_count + 1))
      fi
    else
      matched=$artifact; matched_count=$((matched_count + 1))
    fi
  done

  if [ "$matched_count" -gt 1 ]; then
    [ -n "$expect_version" ] || { matched=$(ls -1t "$INCOMING"/*.zip | head -1); matched_count=1; }
  fi
  [ "$matched_count" -eq 1 ] || die "ожидался ровно один артефакт для цели '${expect_version:-<новейший>}', найдено $matched_count"

  local meta_member release_id target_dir stage src previous_target dir base stale fresh_copy tmp_pin
  meta_member=$(unzip -Z1 "$matched" | grep '[^/]*/build-metadata.json$' | head -1)
  release_id=$(unzip -p "$matched" "$meta_member" | jq -r .releaseId)
  [ -n "$release_id" ] && [ "$release_id" != "null" ] || die "в артефакте нет releaseId"
  case "$release_id" in
    */*|.|..) die "небезопасный releaseId в артефакте" ;;
  esac
  log "цель: $release_id ($(basename "$matched"))"

  target_dir=$RELEASES/$release_id
  [ ! -L "$target_dir" ] || die "каталог релиза не должен быть символьной ссылкой: $target_dir"
  if [ -d "$target_dir" ]; then
    log "релиз уже установлен: $target_dir"
  else
    stage=$(mktemp -d "$RELEASES/.stage.XXXXXX")
    unzip -q "$matched" -d "$stage"
    src=$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -1)
    [ -n "$src" ] || { rm -rf "$stage"; die "пустой артефакт"; }
    jq -e '.releaseId and .gitCommit and .schema == "pcms-release-build/1"' "$src/build-metadata.json" >/dev/null
    if [ -f "$src/release-manifest.json" ]; then
      [ "$(jq -r .version "$src/release-manifest.json")" = "$(jq -r .version "$src/build-metadata.json")" ] \
        && [ "$(jq -r .releaseId "$src/release-manifest.json")" = "$release_id" ] \
        || { rm -rf "$stage"; die "release-manifest.json расходится с build-metadata.json"; }
    fi
    [ -f "$src/update-manifest.json" ] || { rm -rf "$stage"; die "в релизе нет update-manifest.json"; }
    mv "$src" "$target_dir"
    rm -rf "$stage"
    log "установлен релиз: $target_dir"
  fi
  normalize_release_permissions "$target_dir"
  verify_release_access "$target_dir"

  # The confined backup unit uses a pinned script; updates must refresh it too.
  if [ -f "$target_dir/deploy/scripts/backup-site.sh" ]; then
    local tmp_backup
    tmp_backup=$(mktemp "$PIN_DIR/.backup-site.XXXXXX")
    cp "$target_dir/deploy/scripts/backup-site.sh" "$tmp_backup"
    chmod 750 "$tmp_backup"; chown root:"$SERVICE_USER" "$tmp_backup"
    mv -f "$tmp_backup" "$PIN_DIR/backup-site.sh"
  fi

  previous_target=$(readlink -f "$CURRENT" 2>/dev/null || true)
  if [ "$previous_target" != "$target_dir" ]; then
    local receipt
    receipt=$(mktemp "$PIN_DIR/.deployment.XXXXXX")
    jq -n --arg previous "$previous_target" --arg target "$target_dir" '{previous:$previous,target:$target}' > "$receipt"
    chown root:root "$receipt"; chmod 600 "$receipt"
    mv -f "$receipt" "$PIN_DIR/deployment.json"
  fi
  trap '
    rc=$?
    if [ "$rc" -ne 0 ] && [ -n "$previous_target" ] && [ -d "$previous_target" ] &&
      [ "$(readlink -f "$CURRENT")" = "$target_dir" ]; then
      ln -sfn "$previous_target" "$CURRENT.tmp" && mv -T "$CURRENT.tmp" "$CURRENT"
      log "активация отменена до миграций: $previous_target"
    fi
    exit "$rc"
  ' EXIT
  ln -sfn "$target_dir" "$CURRENT.tmp" && mv -T "$CURRENT.tmp" "$CURRENT"
  log "активирован: $(readlink -f "$CURRENT")"
  install_cli_launcher /usr/local/bin/cms

  rm -f "$matched" "$matched.sha256"
  log "входящий артефакт потреблён: $(basename "$matched")"

  # Keep the current release and the previous release for recovery.
  for dir in "$RELEASES"/v[0-9]*-*; do
    [ -d "$dir" ] || continue
    base=$(basename "$dir")
    [ "$base" = "$(basename "$target_dir")" ] && continue
    [ -n "$previous_target" ] && [ "$base" = "$(basename "$previous_target")" ] && continue
    rm -rf -- "$dir"
    log "retention: удалён старый релиз $base"
  done
  stale=$(ls -1t "$INCOMING"/*.zip 2>/dev/null | tail -n +3 || true)
  for artifact in $stale; do
    rm -f -- "$artifact" "$artifact.sha256"
    log "retention: удалён старый входящий артефакт $(basename "$artifact")"
  done

  # Self-refresh пина: только копией с маркером НЕ ниже исполняющейся версии —
  # старый артефакт не имеет права откатить логику установщика.
  fresh_copy="$target_dir/deploy/scripts/install-release.sh"
  if [ -f "$fresh_copy" ] && [ "$SCRIPT_PATH" != "$fresh_copy" ] && ! cmp -s "$SCRIPT_PATH" "$fresh_copy"; then
    if [ "$(marker_version "$fresh_copy")" -gt "$SELF_VERSION" ] && [ -w "$(dirname "$SCRIPT_PATH")" ]; then
      tmp_pin=$(mktemp "$(dirname "$SCRIPT_PATH")/.install-release.XXXXXX")
      cp "$fresh_copy" "$tmp_pin"
      chmod 750 "$tmp_pin"; chown root:"$SERVICE_USER" "$tmp_pin" 2>/dev/null || true
      mv -f "$tmp_pin" "$SCRIPT_PATH"
      log "пин установщика обновлён: $SCRIPT_PATH"
    fi
  fi
)

# ---------- приложение: CLI текущего релиза и сервисные действия --------------
seed_reference_theme() {
  # renderDir из шаблона указывает сюда; без темы web не стартует (fail-secure).
  if [ ! -e "$STATEROOT/themes/reference-theme-v1/theme.json" ] \
     && [ -d "$CURRENT/themes/reference-theme-v1" ]; then
    cp -a "$CURRENT/themes/reference-theme-v1" "$STATEROOT/themes/"
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$STATEROOT/themes/reference-theme-v1"
    log "reference-тема скопирована в $STATEROOT/themes/ (сайт-агент заменит своей)"
  fi
}

cms_cli() { PCMS_CONFIG_FILE=$CONFIG node "$CURRENT/packages/cli/src/bin/cms.js" "$@"; }

install_cli_launcher() { # $1 = operator command path
  local target=$1 temp
  if { [ -e "$target" ] || [ -L "$target" ]; } && ! grep -qF '# Progressive CMS managed CLI launcher' "$target"; then
    log "существующая команда $target сохранена (не управляется установщиком)"
    return 0
  fi
  temp=$(mktemp)
  cat > "$temp" <<EOF
#!/usr/bin/env bash
# Progressive CMS managed CLI launcher
export PCMS_CONFIG_FILE="\${PCMS_CONFIG_FILE:-$CONFIG}"
exec node "$CURRENT/packages/cli/src/bin/cms.js" "\$@"
EOF
  install -D -m 755 "$temp" "$target"
  rm -f "$temp"
}

wait_ready() { # $1 = адрес web
  local i
  for i in $(seq 1 30); do
    if curl -fsS "http://$1:$WEB_PORT/health/ready" >/dev/null 2>&1; then
      log "web готов: http://$1:$WEB_PORT/health/ready"
      return 0
    fi
    sleep 1
  done
  die "web не отвечает на http://$1:$WEB_PORT/health/ready (30 c) — journalctl -u progressive-cms-web"
}

bind_primary_domain() { # $1 = hostname; идемпотентно
  # env без префикса PCMS_: лоадер конфига отвергает неизвестные PCMS_*-переменные
  INSTALLER_BIND_HOST="$1" node --input-type=module - <<'NODE' || {
import { loadConfig, loadSecrets, createDbPool, buildDbConnectionInfo } from "/opt/progressive-cms/current/packages/core/src/index.js";
import { createDomainService, createRouteService } from "/opt/progressive-cms/current/packages/routing/src/index.js";
const hostname = process.env.INSTALLER_BIND_HOST;
const cfg = loadConfig({ file: "/etc/progressive-cms/pcms.json" });
const pool = createDbPool({ connectionInfo: buildDbConnectionInfo(cfg.db, loadSecrets(cfg.secrets)), max: 2 });
const domains = createDomainService(pool);
// ensureSite (не findSiteByKey): на чистой установке строки sites ещё нет —
// она создаётся лениво первым запросом к web.
const site = await createRouteService(pool).ensureSite("default");
if (!(await domains.listDomainBindings(site.id)).some((b) => b.hostname === hostname)) {
  await domains.addDomainBinding({ siteId: site.id, hostname, isPrimary: true });
}
await pool.end();
NODE
    log "ВНИМАНИЕ: привязка основного домена не подтверждена; проверьте доменную настройку сайта после установки"
    return 0
  }
  log "первичный домен привязан: $1"
}

stage_artifact() { # $1 = путь к .zip; кладёт в incoming (+ sidecar при необходимости)
  local artifact=$1
  [ -r "$artifact" ] || die "артефакт не найден: $artifact"
  mkdir -p "$INCOMING"; chown root:"$SERVICE_USER" "$INCOMING"; chmod 2770 "$INCOMING"
  # Уже лежит в incoming (файл-пуш мимо --artifact) — копировать нечего.
  if [ "$(readlink -f "$artifact")" != "$(readlink -f "$INCOMING/$(basename "$artifact")")" ]; then
    cp "$artifact" "$INCOMING/"
  fi
  if [ ! -f "$INCOMING/$(basename "$artifact").sha256" ]; then
    (cd "$(dirname "$artifact")" && sha256sum "$(basename "$artifact")") > "$INCOMING/$(basename "$artifact").sha256"
    log "checksum sidecar создан на месте (артефакт вне реестра)"
  fi
}

# ---------- режим 1: BOOTSTRAP ------------------------------------------------
bootstrap() {
  [ "$(id -u)" = 0 ] || die "первичная установка требует root (sudo)"
  [ ! -f "$CONFIG" ] || die "конфиг уже существует ($CONFIG) — это не первичная установка; скрипт перешёл бы в режим обновления"

  if [ "$INTERACTIVE" = 1 ]; then
    printf '\n== Progressive CMS — первичная установка ==\n\n'
    if [ -z "$OPT_SITE_HOST" ]; then
      ask OPT_SITE_HOST '1/6 Публичное доменное имя сайта (например site.example.com)' '' valid_hostname 'доменное имя'
    fi
    if [ -z "$OPT_PG" ]; then
      ask_choice OPT_PG '2/6 PostgreSQL' 'local' 'local' 'remote'
      if [ "$OPT_PG" = remote ]; then
        [ -n "$OPT_DB_HOST" ] || ask OPT_DB_HOST '    Адрес сервера PostgreSQL' '' valid_ip 'IPv4-адрес'
        [ -n "$OPT_DB_NAME" ] || ask OPT_DB_NAME '    Имя базы' ''
        [ -n "$OPT_DB_USER" ] || ask OPT_DB_USER '    Пользователь базы' ''
        [ -n "$OPT_DB_PASSWORD_FILE" ] || ask OPT_DB_PASSWORD_FILE '    Файл с паролем пользователя базы' '' valid_path 'существующий файл'
      fi
    fi
    if [ -z "$OPT_PROFILE" ]; then
      ask_choice OPT_PROFILE '3/6 Публикация' 'local-nginx' 'local-nginx' 'external-rp'
      if [ "$OPT_PROFILE" = external-rp ] && [ -z "$OPT_HTTP_HOST" ]; then
        ask OPT_HTTP_HOST '    Адрес, который слушает web (приватный IP этого хоста)' '' valid_ip 'IPv4-адрес'
      fi
    fi
    if [ "$OPT_PROFILE" = external-rp ] && [ -z "$OPT_TRUSTED_PROXY_EDGE" ]; then
      ask OPT_TRUSTED_PROXY_EDGE '    Адрес/CIDR внешнего reverse proxy (кто напрямую подключается к web; его видно в журнале web как http.untrusted_proxy_headers peer_ip)' '' valid_proxy_addr 'IPv4/IPv6-адрес или CIDR (не 0.0.0.0/0)'
    fi
    if [ -z "$OPT_ADMIN_EMAIL" ]; then
      ask OPT_ADMIN_EMAIL '4/6 E-mail владельца админки' "owner@${OPT_SITE_HOST}"
    fi
    if [ -z "$OPT_ARTIFACT" ] && [ "$OPT_FROM_INCOMING" = 0 ]; then
      ask OPT_ARTIFACT "5/6 Релизный артефакт .zip (Enter — новейший из $INCOMING)" ''
    fi
    if [ -z "$OPT_REGISTRY_TOKEN_FILE" ]; then
      printf '    Файл с токеном реестра my.p-cms.ru (Enter — настроить обновления позже): '
      IFS= read -r OPT_REGISTRY_TOKEN_FILE
      [ -z "$OPT_REGISTRY_TOKEN_FILE" ] || [ -e "$OPT_REGISTRY_TOKEN_FILE" ] || \
        { printf '  (файл не найден: %s)\n' "$OPT_REGISTRY_TOKEN_FILE" >&2; OPT_REGISTRY_TOKEN_FILE=; }
    fi
    local __confirm=
    printf '6/6 Начать установку? (введите yes): '
    IFS= read -r __confirm
    [ "$__confirm" = yes ] || die "отменено оператором"
  else
    [ -n "$OPT_SITE_HOST" ] || die "тихий режим: укажите --site-host; все параметры передаются флагами, подтверждение --yes"
    if [ "$OPT_PG" = remote ]; then
      [ -n "$OPT_DB_HOST" ] && [ -n "$OPT_DB_NAME" ] && [ -n "$OPT_DB_USER" ] && [ -n "$OPT_DB_PASSWORD_FILE" ] || \
        die "--pg remote: нужны --db-host --db-name --db-user --db-password-file"
    fi
  fi

  # --- дефолты и валидация ----------------------------------------------------
  OPT_PROFILE=${OPT_PROFILE:-local-nginx}
  case "$OPT_PROFILE" in local-nginx|external-rp) ;; *) die "--profile: local-nginx|external-rp" ;; esac
  OPT_PG=${OPT_PG:-local}
  case "$OPT_PG" in local|remote) ;; *) die "--pg: local|remote" ;; esac
  OPT_DB_PORT=${OPT_DB_PORT:-5432}
  if [ "$OPT_PG" = local ]; then
    OPT_DB_HOST=127.0.0.1
    OPT_DB_NAME=${OPT_DB_NAME:-pcms_$(printf '%s' "$OPT_SITE_HOST" | tr -c 'a-z0-9' '_' | sed 's/_*$//' | cut -c1-40)}
    OPT_DB_USER=${OPT_DB_USER:-pcms_app}
  fi
  OPT_DB_OWNER=${OPT_DB_OWNER:-${OPT_DB_USER}_owner}
  if [ "$OPT_PROFILE" = local-nginx ]; then
    OPT_HTTP_HOST=${OPT_HTTP_HOST:-127.0.0.1}
    OPT_TRUSTED_PROXY_EDGE=${OPT_TRUSTED_PROXY_EDGE:-127.0.0.1}
  else
    [ -n "$OPT_HTTP_HOST" ] || die "external-rp: обязателен --http-host (адрес, который слушает web)"
    # Require a topology-specific proxy peer instead of assuming a default.
    [ -n "$OPT_TRUSTED_PROXY_EDGE" ] || die "external-rp: обязателен --trusted-proxy-edge <адрес/CIDR внешнего reverse proxy> (peer web виден в журнале http.untrusted_proxy_headers)"
    valid_proxy_addr "$OPT_TRUSTED_PROXY_EDGE" || die "--trusted-proxy-edge: ожидался IPv4/IPv6-адрес или CIDR ('$OPT_TRUSTED_PROXY_EDGE'); доверять всем (0.0.0.0/0, ::/0) нельзя"
  fi
  valid_hostname "$OPT_SITE_HOST" || die "--site-host: некорректное доменное имя '$OPT_SITE_HOST'"
  OPT_ADMIN_EMAIL=${OPT_ADMIN_EMAIL:-owner@${OPT_SITE_HOST}}
  log "хост: $OPT_SITE_HOST; профиль: $OPT_PROFILE; pg: $OPT_PG ($OPT_DB_HOST:$OPT_DB_PORT/$OPT_DB_NAME)"

  # --- пакеты и Node 24 ---------------------------------------------------------
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  local PKGS="unzip curl ca-certificates gnupg jq polkitd postgresql-client"
  [ "$OPT_PROFILE" = local-nginx ] && PKGS+=" nginx"
  apt-get install -y -qq $PKGS >/dev/null
  if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(/^\D*24\./.test(process.version) ? 0 : 1)'; then
    log "ставлю Node.js 24 (NodeSource)"
    local NS; NS=$(mktemp)
    curl -fsSL https://deb.nodesource.com/setup_24.x -o "$NS"
    bash "$NS" >/dev/null; rm -f "$NS"
    apt-get install -y -qq nodejs >/dev/null
  fi
  log "node $(node --version)"

  # --- journald, системный пользователь, каталоги --------------------------------
  mkdir -p /var/log/journal
  systemd-tmpfiles --create --prefix=/var/log/journal >/dev/null
  id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$STATEROOT" \
    --shell /usr/sbin/nologin --user-group "$SERVICE_USER"
  mkdir -p "$PREFIX/releases" "$INCOMING" "$SECRETS" \
    "$STATEROOT/media" "$STATEROOT/state/tmp/media-quarantine" \
    "$STATEROOT/state/tmp/pcpub-quarantine" "$STATEROOT/themes" \
    /var/backups/progressive-cms /var/www/progressive-cms-emergency "$RUNDIR"
  chown root:root /var/www/progressive-cms-emergency
  chmod 755 /var/www/progressive-cms-emergency
  chown root:root "$PREFIX" "$PREFIX/releases"; chmod 755 "$PREFIX" "$PREFIX/releases"
  chown root:"$SERVICE_USER" "$INCOMING" "$ETC" "$SECRETS"
  chmod 2770 "$INCOMING"   # apply-update пишет артефакт от имени сервис-пользователя
  chmod 750 "$ETC" "$SECRETS"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$STATEROOT" /var/backups/progressive-cms "$RUNDIR"
  chmod 750 "$STATEROOT" /var/backups/progressive-cms "$RUNDIR"

  # --- PostgreSQL ------------------------------------------------------------------
  local PW
  if [ "$OPT_PG" = local ]; then
    if [ -n "$OPT_DB_PASSWORD_FILE" ]; then
      PW=$(cat "$OPT_DB_PASSWORD_FILE"); rm -f "$OPT_DB_PASSWORD_FILE"
    else
      PW=$(random_password)
    fi
    pg_provision "$OPT_DB_NAME" "$OPT_DB_OWNER" "$OPT_DB_USER" "127.0.0.1/32" "$PW"
  fi

  # --- артефакт: в incoming; ассеты deploy/ при необходимости — из него же -----------
  if [ -n "$OPT_ARTIFACT" ]; then stage_artifact "$OPT_ARTIFACT"; fi
  if [ -z "$(ls -1 "$INCOMING"/*.zip 2>/dev/null || true)" ]; then
    die "в $INCOMING нет артефакта: положите .zip (+.sha256) или укажите --artifact"
  fi
  if [ ! -r "$ASSETS/sites/pcms.production.template.json" ]; then
    # Скрипт запущен отдельно от дерева deploy/ — развернём ассеты из артефакта.
    local zip_src top assets_stage
    zip_src=$(ls -1t "$INCOMING"/*.zip 2>/dev/null | head -1 || true)
    [ -n "$zip_src" ] && [ -r "$zip_src" ] || die "нет ассетов ($ASSETS) и в $INCOMING нет артефакта"
    assets_stage=$(mktemp -d /tmp/pcms-assets.XXXXXX)
    # Первая компонента пути (в zip нет явных dir-записей, первый член листинга — глубокий файл)
    top=$(unzip -Z1 "$zip_src" | grep -o '^[^/]*/' | head -1 || true)
    [ -n "$top" ] || die "не удалось прочитать артефакт: $zip_src"
    unzip -q "$zip_src" "${top}deploy/*" -d "$assets_stage"
    ASSETS="$assets_stage/$top/deploy"
    [ -r "$ASSETS/sites/pcms.production.template.json" ] || die "в артефакте нет deploy/ — повреждённый артефакт?"
    log "ассеты развернуты из артефакта: $ASSETS"
  fi

  # --- конфиг + секреты --------------------------------------------------------------
  local TEMPLATE=$ASSETS/sites/pcms.production.template.json
  [ -r "$TEMPLATE" ] || die "нет шаблона конфига: $TEMPLATE (проверьте --assets-dir)"
  sed -e "s/__DB_ADDRESS__/${OPT_DB_HOST}/g" \
      -e "s/__DB_NAME__/${OPT_DB_NAME}/g" \
      -e "s/__DB_USER__/${OPT_DB_USER}/g" \
      -e "s/__HTTP_HOST__/${OPT_HTTP_HOST}/g" \
      -e "s|__TRUSTED_PROXY_EDGE__|${OPT_TRUSTED_PROXY_EDGE}|g" \
      "$TEMPLATE" > "$CONFIG"
  if [ "$OPT_DB_PORT" != 5432 ]; then sed -i "s/\"port\": 5432/\"port\": $OPT_DB_PORT/" "$CONFIG"; fi
  if grep -q "__[A-Z_]*__" "$CONFIG"; then
    grep -n "__[A-Z_]*__" "$CONFIG" || true
    die "в конфиге остались плейсхолдеры шаблона"
  fi
  if [ "$OPT_PROFILE" = external-rp ] && ! grep -qF "$OPT_TRUSTED_PROXY_EDGE" "$CONFIG"; then
    die "рендер конфига не содержит доверенный edge ($OPT_TRUSTED_PROXY_EDGE) — прервано до установки"
  fi
  write_secret() { printf '%s' "$2" > "$SECRETS/$1"; chown "$SERVICE_USER":"$SERVICE_USER" "$SECRETS/$1"; chmod 600 "$SECRETS/$1"; }
  if [ "$OPT_PG" = local ]; then
    write_secret db.password "$PW"; unset PW
  else
    [ -n "$OPT_DB_PASSWORD_FILE" ] || die "--pg remote: обязателен --db-password-file"
    write_secret db.password "$(cat "$OPT_DB_PASSWORD_FILE")"; rm -f "$OPT_DB_PASSWORD_FILE"
  fi
  if grep -q '"preview.secret"' "$CONFIG" && [ ! -e "$SECRETS/preview.secret" ]; then
    write_secret preview.secret "$(head -c 32 /dev/urandom | base64)"
  fi
  if grep -q '"integrations.runtimeSecretsEncryptionKey"' "$CONFIG" && [ ! -e "$SECRETS/integrations-runtime.secret" ]; then
    write_secret integrations-runtime.secret "$(head -c 32 /dev/urandom | base64)"
  fi

  # --- реестр артефактов: one-click обновления через веб -------------------------------
  # registry.baseUrl в конфиг; токен гражданина — секрет registry.token (файл).
  # Без токена вкладка «Реестр» попросит его позже — это штатное состояние.
  OPT_REGISTRY_URL=${OPT_REGISTRY_URL:-https://my.p-cms.ru}
  if [ -n "$OPT_REGISTRY_TOKEN_FILE" ]; then
    [ -r "$OPT_REGISTRY_TOKEN_FILE" ] || die "--registry-token-file: файл не найден: $OPT_REGISTRY_TOKEN_FILE"
    write_secret registry.token "$(cat "$OPT_REGISTRY_TOKEN_FILE")"
    rm -f "$OPT_REGISTRY_TOKEN_FILE"
  fi
  INSTALLER_CFG="$CONFIG" INSTALLER_REGISTRY_URL="$OPT_REGISTRY_URL" \
  INSTALLER_REGISTRY_SECRET=$({ [ -n "$OPT_REGISTRY_TOKEN_FILE" ] && printf '%s' "$SECRETS/registry.token"; } || true) \
    node --input-type=module - <<'NODE'
import fs from "node:fs";
const path = process.env.INSTALLER_CFG;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.registry = { baseUrl: process.env.INSTALLER_REGISTRY_URL };
if (process.env.INSTALLER_REGISTRY_SECRET) {
  config.secrets = config.secrets ?? {};
  config.secrets["registry.token"] = { file: process.env.INSTALLER_REGISTRY_SECRET };
}
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
NODE
  if [ -n "$OPT_REGISTRY_TOKEN_FILE" ]; then
    log "реестр подключён: $OPT_REGISTRY_URL (токен на месте — one-click обновления активны)"
  else
    log "реестр подключён: $OPT_REGISTRY_URL (без токена — добавьте секрет registry.token позже, см. deploy-package)"
  fi
  chown root:"$SERVICE_USER" "$CONFIG"; chmod 640 "$CONFIG"
  log "конфиг и секреты готовы ($CONFIG)"

  # --- юниты, polkit, операционные скрипты, мост рестарта -----------------------------
  local unit script
  for unit in progressive-cms-web progressive-cms-worker progressive-cms-backup progressive-cms-install; do
    [ -r "$ASSETS/systemd/${unit}.service" ] || die "нет юнита $ASSETS/systemd/${unit}.service (проверьте --assets-dir)"
    install -o root -g root -m 644 "$ASSETS/systemd/${unit}.service" "/etc/systemd/system/${unit}.service"
  done
  [ -r "$ASSETS/polkit/49-progressive-cms-update.rules" ] || die "нет polkit-правила в $ASSETS/polkit/"
  install -D -o root -g root -m 644 "$ASSETS/polkit/49-progressive-cms-update.rules" \
    /etc/polkit-1/rules.d/49-progressive-cms-update.rules
  systemctl restart polkit.service
  mkdir -p "$PIN_DIR"
  chown root:"$SERVICE_USER" "$PIN_DIR"; chmod 750 "$PIN_DIR"
  for script in backup-site.sh restore-site.sh; do
    install -o root -g "$SERVICE_USER" -m 750 "$ASSETS/scripts/$script" "$PIN_DIR/$script"
  done
  install -o root -g "$SERVICE_USER" -m 750 "$SCRIPT_PATH" "$PIN_DIR/install-release.sh"
  log "юниты, polkit и операционные скрипты установлены"
  if [ "$OPT_NO_BRIDGE" = 0 ] && [ -r "$ASSETS/scripts/install-restart-bridge.sh" ]; then
    if PROVISION_ASSETS_DIR="$ASSETS" bash "$ASSETS/scripts/install-restart-bridge.sh"; then
      log "мост рестарта установлен (рестарт после обновления без root-сессии)"
    else
      log "ВНИМАНИЕ: мост рестарта не установился — рестарт после обновления вручную"
    fi
  fi

  # --- nginx vhost (local-nginx) --------------------------------------------------------
  if [ "$OPT_PROFILE" = local-nginx ]; then
    sed "s/__SITE_HOST__/${OPT_SITE_HOST}/g" "$ASSETS/nginx/progressive-cms.conf" \
      > /etc/nginx/sites-available/progressive-cms.conf
    cp "$ASSETS/nginx/proxy-snippet.conf" /etc/nginx/snippets/progressive-cms-proxy.conf
    ln -sfn /etc/nginx/sites-available/progressive-cms.conf /etc/nginx/sites-enabled/progressive-cms.conf
    rm -f /etc/nginx/sites-enabled/default
    if [ -r "$ASSETS/maintenance/emergency.html" ]; then
      install -m 644 "$ASSETS/maintenance/emergency.html" \
        /var/www/progressive-cms-emergency/_pcms_emergency_maintenance.html
    fi
    nginx -t
    systemctl reload nginx
    log "nginx vhost настроен для $OPT_SITE_HOST (TLS дальше — certbot)"
  fi

  # --- установка релиза, миграции, домен, запуск -----------------------------------------
  install_from_incoming 0
  seed_reference_theme

  log "миграции БД..."
  cms_cli db migrate
  bind_primary_domain "$OPT_SITE_HOST"
  systemctl enable --quiet progressive-cms-web progressive-cms-worker progressive-cms-backup 2>/dev/null || true
  # reset-failed: если юнит падал до этого (крash-loop до фикса), systemd-рейт-лимит
  # иначе молча отклонит рестарт («Start request repeated too quickly»).
  systemctl reset-failed progressive-cms-web progressive-cms-worker 2>/dev/null || true
  systemctl restart progressive-cms-worker progressive-cms-web
  wait_ready "$OPT_HTTP_HOST"
  log "doctor:"
  cms_cli doctor || die "doctor сообщил о проблемах — смотрите вывод выше"

  # --- владелец --------------------------------------------------------------------------
  local OWNER_PW
  OWNER_PW=$(random_password)
  if printf '%s\n' "$OWNER_PW" | cms_cli user create-owner --email "$OPT_ADMIN_EMAIL" --name Owner >/dev/null; then
    umask 077
    printf 'Progressive CMS: %s\nадминка: https://%s/admin\nвладелец: %s\nпароль: %s\n(смените пароль после первого входа)\n' \
      "$(basename "$(readlink -f "$CURRENT")")" "$OPT_SITE_HOST" "$OPT_ADMIN_EMAIL" "$OWNER_PW" \
      > /root/owner-bootstrap.txt
    log "владелец создан: $OPT_ADMIN_EMAIL — пароль одноразово записан в /root/owner-bootstrap.txt"
  else
    log "владелец уже существует — создание пропущено (пароль в /root/owner-bootstrap.txt от первой установки)"
  fi
  unset OWNER_PW

  # --- итог --------------------------------------------------------------------------------
  local site_addr=$OPT_SITE_HOST
  [ "$OPT_PROFILE" = external-rp ] && site_addr=$OPT_HTTP_HOST
  printf '\n== Установка завершена ==\n'
  printf '  Сайт:     http://%s/\n' "$site_addr"
  printf '  Админка:  http://%s/admin (%s; пароль — /root/owner-bootstrap.txt)\n' "$site_addr" "$OPT_ADMIN_EMAIL"
  printf '  Домен:    направьте DNS %s сюда; TLS включите на внешнем RP (или certbot при local-nginx)\n' "$OPT_SITE_HOST"
  printf '  Обновления: этот же скрипт без аргументов (артефакт .zip+.sha256 в %s),\n' "$INCOMING"
  printf '              либо one-click из реестра (config registry.baseUrl + секрет registry.token)\n'
}

# ---------- режим 2: ручное обновление ------------------------------------------
manual_update() {
  [ "$(id -u)" = 0 ] || die "обновление требует root (sudo)"
  if [ -n "$OPT_ARTIFACT" ]; then stage_artifact "$OPT_ARTIFACT"; fi
  install_from_incoming 0
  seed_reference_theme
  log "миграции нового релиза..."
  cms_cli db migrate
  systemctl enable --quiet progressive-cms-web progressive-cms-worker 2>/dev/null || true
  systemctl reset-failed progressive-cms-web progressive-cms-worker 2>/dev/null || true
  systemctl restart progressive-cms-worker progressive-cms-web
  local web_addr
  web_addr=$(node -e 'const c=require("/etc/progressive-cms/pcms.json");process.stdout.write(c.http.host)' 2>/dev/null || echo 127.0.0.1)
  wait_ready "$web_addr"
  log "doctor:"
  cms_cli doctor || die "doctor сообщил о проблемах после обновления"
  log "обновление завершено: $(readlink -f "$CURRENT")"
}

# ---------- диспетчер ----------------------------------------------------------
IS_ORCHESTRATED=0
[ -n "${INVOCATION_ID:-}" ] && IS_ORCHESTRATED=1

# Validate external-rp before root checks and any side effects.
if [ "$OPT_PROFILE" = external-rp ]; then
  if [ -z "$OPT_TRUSTED_PROXY_EDGE" ]; then
    if [ "$OPT_YES" = 1 ]; then
      die "external-rp: укажите --trusted-proxy-edge <IPv4/IPv6-адрес или CIDR внешнего reverse proxy> — peer web виден в журнале http.untrusted_proxy_headers"
    fi
  else
    valid_proxy_addr "$OPT_TRUSTED_PROXY_EDGE" || die "--trusted-proxy-edge: ожидался IPv4/IPv6-адрес или CIDR ('$OPT_TRUSTED_PROXY_EDGE'); доверять всем (0.0.0.0/0, ::/0) нельзя"
  fi
fi

if [ "$IS_ORCHESTRATED" = 1 ]; then
  # Юнит progressive-cms-install.service: только артефакт; миграции/рестарты/doctor
  # делает оркестратор (`cms update apply` / apply-update из реестра).
  if [ -f "$INCOMING/rollback-deployment.json" ]; then
    rollback_failed_deployment
  else
    install_from_incoming 1
  fi
elif [ -f "$CONFIG" ]; then
  manual_update
else
  bootstrap
fi
