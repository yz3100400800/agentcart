import raw from "@/data/catalog.json";
import { searchCatalog } from "@/lib/cart";
import type { CatalogSummary, Product, ProductKind } from "@/lib/types";

const KINDS = new Set<ProductKind>(["per_person", "consumable", "shared"]);

export function parseCatalog(input: unknown): Product[] {
  if (!input || typeof input !== "object" || !("products" in input) || !Array.isArray(input.products)) {
    throw new Error("Catalog must be an object with a products array.");
  }
  const products = input.products.map((item, index) => parseProduct(item, index));
  const seen = new Set<string>();
  for (const product of products) {
    if (seen.has(product.sku)) throw new Error(`Duplicate SKU ${product.sku}`);
    seen.add(product.sku);
  }
  return products;
}

function parseProduct(item: unknown, index: number): Product {
  if (!item || typeof item !== "object") {
    throw new Error(`Product ${index} is not an object.`);
  }
  const rawProduct = item as Record<string, unknown>;
  const sku = requiredString(rawProduct.sku, `products[${index}].sku`);
  const name = requiredString(rawProduct.name, `products[${index}].name`);
  const brand = requiredString(rawProduct.brand, `products[${index}].brand`);
  const description = requiredString(rawProduct.description, `products[${index}].description`);
  const category = requiredString(rawProduct.category, `products[${index}].category`);
  const kind = rawProduct.kind;
  if (typeof kind !== "string" || !KINDS.has(kind as ProductKind)) {
    throw new Error(`products[${index}].kind is invalid.`);
  }
  const priceCents = positiveInt(rawProduct.priceCents, `products[${index}].priceCents`);
  const maxQty = positiveInt(rawProduct.maxQty, `products[${index}].maxQty`);
  if (!Array.isArray(rawProduct.tags) || rawProduct.tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`products[${index}].tags must be a string array.`);
  }

  const product: Product = {
    sku,
    name,
    brand,
    description,
    category,
    priceCents,
    kind: kind as ProductKind,
    maxQty,
    tags: rawProduct.tags,
  };

  if (product.kind === "consumable") {
    product.servingsPerUnit = positiveInt(
      rawProduct.servingsPerUnit,
      `products[${index}].servingsPerUnit`,
    );
    product.servingsPerPersonPerDay = positiveNumber(
      rawProduct.servingsPerPersonPerDay,
      `products[${index}].servingsPerPersonPerDay`,
    );
  }

  return product;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

export const products = parseCatalog(raw);

export function listCategories(all: Product[] = products): string[] {
  return [...new Set(all.map((product) => product.category))].sort((a, b) => a.localeCompare(b));
}

export function findProduct(sku: string, all: Product[] = products): Product | undefined {
  return all.find((product) => product.sku === sku);
}

export function searchProducts(
  query: string,
  category?: string,
  limit = 8,
  all: Product[] = products,
): Product[] {
  return searchCatalog(all, query, category, limit);
}

export function catalogSummary(all: Product[] = products): CatalogSummary[] {
  return all.map((product) => ({
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    category: product.category,
    priceCents: product.priceCents,
    kind: product.kind,
  }));
}
