#!/bin/sh
# Seeds the Elasticsearch / OpenSearch test servers with a small shop: run
# inside the container by `make test-db ENGINE=elasticsearch|opensearch…` as
#   sh /seed/search-shop.sh <base URL> [curl options…]
# Indices shop-customers, shop-products, shop-orders (nested items) and
# shop-reviews (Korean and English text), the alias `shop` over all four and
# `orders` over shop-orders, and the data stream logs-shop-default.
# Deterministic (testdb/search-shop.ndjson); re-running starts over.
# Elasticsearch 6 (mapping types) gets typeless indices (`_doc`) and no
# data stream (they came with 7.9).
set -eu
base="$1"
shift
call() {
  method="$1"
  path="$2"
  shift 2
  status=$(curl -sS -o /tmp/search-shop.out -w '%{http_code}' -X "$method" "$@" "$base$path")
  if [ "$status" -ge 300 ]; then
    echo "$method $path: HTTP $status" >&2
    cat /tmp/search-shop.out >&2
    exit 1
  fi
}
root=$(curl -sS "$@" "$base/")
major=$(printf '%s' "$root" | sed -n 's/.*"number" *: *"\([0-9]*\)\..*/\1/p' | head -n 1)
typeless=""
# OpenSearch numbers its versions afresh (1.x, 2.x): only Elasticsearch 6 has types.
if ! printf '%s' "$root" | grep -q '"distribution" *: *"opensearch"' && [ "${major:-7}" -lt 7 ]; then
  typeless="?include_type_name=false"
fi
for index in shop-customers shop-products shop-orders shop-reviews; do
  curl -sS -X DELETE "$@" "$base/$index" > /dev/null || true
done
if [ -z "$typeless" ]; then
  curl -sS -X DELETE "$@" "$base/_data_stream/logs-shop-default" > /dev/null || true
fi
call PUT "/shop-customers$typeless" "$@" -H 'Content-Type: application/json' -d '{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": { "properties": {
    "customer_no": { "type": "integer" },
    "name": { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
    "email": { "type": "keyword" },
    "tier": { "type": "keyword" },
    "address": { "properties": {
      "city": { "type": "keyword" }, "country": { "type": "keyword" },
      "zip": { "type": "keyword" }, "location": { "type": "geo_point" } } },
    "tags": { "type": "keyword" },
    "phone": { "type": "keyword" },
    "signed_up_at": { "type": "date" },
    "active": { "type": "boolean" } } } }'

call PUT "/shop-products$typeless" "$@" -H 'Content-Type: application/json' -d '{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": { "properties": {
    "sku": { "type": "keyword" },
    "name": { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
    "description": { "type": "text" },
    "price": { "type": "scaled_float", "scaling_factor": 100 },
    "stock": { "type": "integer" },
    "attributes": { "properties": { "color": { "type": "keyword" }, "weight_g": { "type": "integer" } } },
    "categories": { "type": "keyword" },
    "released_on": { "type": "date" } } } }'

call PUT "/shop-orders$typeless" "$@" -H 'Content-Type: application/json' -d '{
  "settings": { "number_of_shards": 2, "number_of_replicas": 0 },
  "mappings": { "properties": {
    "order_no": { "type": "keyword" },
    "customer_no": { "type": "integer" },
    "status": { "type": "keyword" },
    "items": { "type": "nested", "properties": {
      "sku": { "type": "keyword" }, "name": { "type": "text" },
      "quantity": { "type": "integer" }, "price": { "type": "scaled_float", "scaling_factor": 100 } } },
    "total": { "type": "scaled_float", "scaling_factor": 100 },
    "currency": { "type": "keyword" },
    "ordered_at": { "type": "date" } } } }'

call PUT "/shop-reviews$typeless" "$@" -H 'Content-Type: application/json' -d '{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": { "properties": {
    "sku": { "type": "keyword" },
    "customer_no": { "type": "integer" },
    "rating": { "type": "byte" },
    "title": { "type": "text" },
    "body": { "type": "text" },
    "created_at": { "type": "date" } } } }'

if [ -n "$typeless" ]; then
  sed 's/^{"index": {/{"index": {"_type": "_doc", /' /seed/search-shop.ndjson > /tmp/search-shop.ndjson
else
  cp /seed/search-shop.ndjson /tmp/search-shop.ndjson
fi
call POST '/_bulk?refresh=true' "$@" -H 'Content-Type: application/x-ndjson' --data-binary @/tmp/search-shop.ndjson

call POST /_aliases "$@" -H 'Content-Type: application/json' -d '{ "actions": [
  { "add": { "indices": ["shop-customers", "shop-products", "shop-orders", "shop-reviews"], "alias": "shop" } },
  { "add": { "index": "shop-orders", "alias": "orders", "is_write_index": true } } ] }'

if [ -n "$typeless" ]; then
  exit 0
fi

call PUT /_index_template/logs-shop "$@" -H 'Content-Type: application/json' -d '{
  "index_patterns": ["logs-shop-*"], "data_stream": {}, "priority": 500,
  "template": { "settings": { "number_of_replicas": 0 },
    "mappings": { "properties": { "@timestamp": { "type": "date" }, "event": { "type": "keyword" },
      "customer_no": { "type": "integer" }, "message": { "type": "text" } } } } }'

call POST '/logs-shop-default/_bulk?refresh=true' "$@" -H 'Content-Type: application/x-ndjson' --data-binary @/seed/search-shop-events.ndjson
