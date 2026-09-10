#!/bin/bash
# example deployment startup script
# adapt to your environment (pm2, systemd, docker, etc.)

# load environment variables from .env file
if [ -f .env ]; then
    echo "loading environment variables from .env"
    set -a
    . .env
    set +a
else
    echo "warning: .env file not found. ensure environment variables are set."
fi

# --- database pre-flight check ---
if [ -n "$POSTGRESQL_URI" ]; then
    DB_HOST=$(echo "$POSTGRESQL_URI" | sed -E 's|.*@([^:/]+).*|\1|')
    DB_PORT=$(echo "$POSTGRESQL_URI" | sed -E 's|.*:([0-9]+)/.*|\1|')
    [ -z "$DB_PORT" ] && DB_PORT="5432"

    echo "database pre-flight: checking $DB_HOST:$DB_PORT ..."

    db_max_attempts=12
    db_attempt=1
    db_wait=5

    while [ $db_attempt -le $db_max_attempts ]; do
        if bash -c "echo > /dev/tcp/$DB_HOST/$DB_PORT" 2>/dev/null; then
            echo "database at $DB_HOST:$DB_PORT is reachable (attempt $db_attempt/$db_max_attempts)"
            break
        fi
        echo "database at $DB_HOST:$DB_PORT not reachable (attempt $db_attempt/$db_max_attempts)"
        if [ $db_attempt -ge $db_max_attempts ]; then
            echo "error: database not reachable after $db_max_attempts attempts. aborting."
            exit 1
        fi
        echo "retrying in ${db_wait}s ..."
        sleep $db_wait
        db_attempt=$((db_attempt + 1))
    done
else
    echo "warning: POSTGRESQL_URI not set, skipping database pre-flight check."
fi

# --- filesystem writability check ---
check_writable() {
    local test_file="/tmp/litter_write_test"
    if touch "$test_file" 2>/dev/null; then
        rm "$test_file"
        return 0
    else
        return 1
    fi
}

max_attempts=5
attempt=1
while ! check_writable; do
    echo "filesystem appears to be read-only. attempt $attempt of $max_attempts."
    if [ $attempt -ge $max_attempts ]; then
        echo "error: filesystem still read-only. exiting."
        exit 1
    fi
    echo "waiting 5 seconds before retrying..."
    sleep 5
    attempt=$((attempt + 1))
done

echo "filesystem is writable. starting application..."
npm install --no-audit --no-fund
npm start
