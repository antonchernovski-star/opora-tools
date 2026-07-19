#!/bin/bash
# setup.sh — установка сервиса автопроверки лидов «Опоры» на VPS.
# Debian/Ubuntu. Запуск от root:
#   wget -qO- https://raw.githubusercontent.com/antonchernovski-star/opora-tools/main/server/setup.sh | bash
#
# Что делает: Node.js 20, /opt/opora-check/check-lead.js, .env с
# случайным токеном, systemd-сервис, nginx + Let's Encrypt на домене
# <IP с дефисами>.sslip.io (DNS-сервис sslip.io отдаёт IP по имени —
# свой домен не нужен). В конце печатает адреса /setup и /check.

set -e
export DEBIAN_FRONTEND=noninteractive

REPO=https://raw.githubusercontent.com/antonchernovski-star/opora-tools/main/server
DIR=/opt/opora-check

echo "== [1/6] Пакеты =="
apt-get update -qq
apt-get install -y -qq curl wget nginx certbot python3-certbot-nginx openssl >/dev/null

echo "== [2/6] Node.js 20 =="
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "== [3/6] Сервис =="
mkdir -p "$DIR"
wget -q -O "$DIR/check-lead.js" "$REPO/check-lead.js"

if [ ! -f "$DIR/.env" ]; then
    TOKEN=$(openssl rand -hex 24)
    cat > "$DIR/.env" <<EOF
PORT=8399
ENDPOINT_TOKEN=$TOKEN
AUTO_CLOSE=0
UF_FIELD=UF_CRM_OPORA_CHECK
SPRAV_URL=https://b2b-api-stage-05.spravportal.ru
EOF
    chmod 600 "$DIR/.env"
else
    TOKEN=$(grep '^ENDPOINT_TOKEN=' "$DIR/.env" | cut -d= -f2)
fi

cat > /etc/systemd/system/opora-check.service <<'EOF'
[Unit]
Description=Opora lead check
After=network.target

[Service]
WorkingDirectory=/opt/opora-check
ExecStart=/usr/bin/node /opt/opora-check/check-lead.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now opora-check >/dev/null 2>&1 || systemctl restart opora-check

echo "== [4/6] Домен =="
IP=$(curl -fsS4 https://ifconfig.me || hostname -I | awk '{print $1}')
DOMAIN=$(echo "$IP" | tr '.' '-').sslip.io
echo "Домен: $DOMAIN"

echo "== [5/6] nginx =="
cat > /etc/nginx/sites-available/opora-check <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:8399;
        proxy_set_header Host \$host;
    }
}
EOF
ln -sf /etc/nginx/sites-available/opora-check /etc/nginx/sites-enabled/opora-check
rm -f /etc/nginx/sites-enabled/default
nginx -t -q && systemctl reload nginx

echo "== [6/6] HTTPS (Let's Encrypt) =="
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect -q || \
    echo "ВНИМАНИЕ: certbot не выдал сертификат — сервис пока на http://"

sleep 2
echo
echo "================= ГОТОВО ================="
echo "Проверка:  curl -s https://$DOMAIN/health"
curl -s "https://$DOMAIN/health" || curl -s "http://$DOMAIN/health" || true
echo
echo
echo "ФОРМА НАСТРОЙКИ (открыть в браузере, вставить ключи):"
echo "  https://$DOMAIN/setup?token=$TOKEN"
echo
echo "URL ДЛЯ РОБОТА BITRIX24:"
echo "  https://$DOMAIN/check?token=$TOKEN&leadId={{ID}}"
echo "=========================================="
