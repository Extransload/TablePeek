// A small shop to look around in: customers with nested addresses and tags,
// products with attributes, orders that embed their items and refer to
// customers by ObjectId, reviews, and an event log. Deterministic.
const shop = db.getSiblingDB("shop");
shop.dropDatabase();

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(rand() * list.length)];

const lastNames = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임"];
const firstNames = ["서연", "민준", "지우", "도윤", "하은", "시우", "지아", "예준", "수아", "주원"];
const cities = [
  { city: "서울", country: "KR" },
  { city: "부산", country: "KR" },
  { city: "Seattle", country: "US" },
  { city: "Berlin", country: "DE" },
  { city: "東京", country: "JP" },
];
const tiers = ["free", "pro", "enterprise"];

const customers = [];
for (let i = 1; i <= 200; i += 1) {
  const place = pick(cities);
  const doc = {
    _id: new ObjectId(),
    customerNo: i,
    name: pick(lastNames) + pick(firstNames),
    email: `user${i}@example.com`,
    tier: pick(tiers),
    address: { ...place, zip: String(10000 + Math.floor(rand() * 89999)) },
    tags: rand() < 0.3 ? ["vip"] : rand() < 0.5 ? ["newsletter", "beta"] : [],
    signedUpAt: new Date(Date.UTC(2024, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27))),
    active: rand() > 0.1,
  };
  if (rand() < 0.2) {
    doc.phone = `010-${1000 + i}-${2000 + i}`;
  }
  customers.push(doc);
}
shop.customers.insertMany(customers);

const kinds = ["마우스", "Keyboard", "텀블러", "Backpack", "램프"];
const colors = ["white", "black", "navy", "red"];
const products = [];
for (let i = 1; i <= 100; i += 1) {
  products.push({
    _id: new ObjectId(),
    sku: `SKU-${String(i).padStart(5, "0")}`,
    name: `${pick(["Pro", "미니", "Ultra", "클래식", "Eco", "무선"])} ${pick(kinds)} ${i}`,
    price: NumberDecimal((5 + rand() * 495).toFixed(2)),
    stock: Math.floor(rand() * 250),
    attributes: { color: pick(colors), weight_g: 100 + i * 3, dimensions: { w: 5 + (i % 20), h: 3 + (i % 15) } },
    categories: rand() < 0.5 ? ["electronics"] : ["lifestyle", "gift"],
    releasedOn: new Date(Date.UTC(2022, i % 12, 1 + (i % 27))),
  });
}
shop.products.insertMany(products);

const statuses = ["pending", "paid", "shipped", "delivered", "cancelled", "refunded"];
const orders = [];
for (let i = 1; i <= 2000; i += 1) {
  const customer = pick(customers);
  const lines = [];
  const count = 1 + Math.floor(rand() * 4);
  for (let n = 0; n < count; n += 1) {
    const product = pick(products);
    const quantity = 1 + Math.floor(rand() * 3);
    lines.push({ productId: product._id, sku: product.sku, name: product.name, quantity, unitPrice: product.price });
  }
  const orderedAt = new Date(Date.UTC(2025, 0, 1) + i * 4 * 3600 * 1000);
  const status = pick(statuses);
  const doc = {
    _id: new ObjectId(),
    orderNo: 100000 + i,
    customerId: customer._id,
    status,
    items: lines,
    total: NumberDecimal(lines.reduce((sum, line) => sum + Number(line.unitPrice.toString()) * line.quantity, 0).toFixed(2)),
    shipping: { ...customer.address, method: pick(["standard", "express"]) },
    orderedAt,
  };
  if (status === "shipped" || status === "delivered") {
    doc.shippedAt = new Date(orderedAt.getTime() + 2 * 24 * 3600 * 1000);
  }
  if (rand() < 0.15) {
    doc.coupon = pick(["WELCOME10", "VIP-20", "SPRING5"]);
  }
  orders.push(doc);
}
shop.orders.insertMany(orders);

const reviews = [];
for (let i = 1; i <= 500; i += 1) {
  reviews.push({
    productId: pick(products)._id,
    customerId: pick(customers)._id,
    rating: 1 + Math.floor(rand() * 5),
    title: pick(["좋아요", "Great value", "배송이 빨라요", "Not bad", "재구매 의사 있음"]),
    body: rand() < 0.5 ? "만족스럽습니다 😀" : null,
    createdAt: new Date(Date.UTC(2025, i % 12, 1 + (i % 27))),
  });
}
shop.reviews.insertMany(reviews);

const events = [];
for (let i = 1; i <= 1000; i += 1) {
  events.push({
    type: pick(["page_view", "add_to_cart", "checkout", "login"]),
    customerId: pick(customers)._id,
    meta: { path: pick(["/", "/products", "/cart", "/checkout"]), referrer: pick([null, "google", "newsletter"]) },
    at: new Date(Date.UTC(2025, 5, 1) + i * 600 * 1000),
  });
}
shop.events.insertMany(events);

shop.orders.createIndex({ customerId: 1, orderedAt: -1 });
shop.orders.createIndex({ status: 1 });
shop.products.createIndex({ sku: 1 }, { unique: true });
shop.customers.createIndex({ email: 1 }, { unique: true });
shop.reviews.createIndex({ productId: 1 });

// A view, to see how one shows up.
shop.createView("order_totals_by_status", "orders", [
  { $group: { _id: "$status", orders: { $sum: 1 }, revenue: { $sum: "$total" } } },
  { $sort: { revenue: -1 } },
]);

printjson({
  customers: shop.customers.countDocuments(),
  products: shop.products.countDocuments(),
  orders: shop.orders.countDocuments(),
  reviews: shop.reviews.countDocuments(),
  events: shop.events.countDocuments(),
});
