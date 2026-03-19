export function buildFilename(
  code: string,
  orderNumber: string,
  index: number,
  total: number,
  urgent: boolean,
): string {
  const normalizedCode = String(code ?? "").trim();
  const normalizedOrder = String(orderNumber ?? "").trim();
  const urgentSuffix = urgent ? "_T" : "";
  return `CGU_${normalizedCode}_${normalizedOrder}_${index}_${total}${urgentSuffix}`;
}
