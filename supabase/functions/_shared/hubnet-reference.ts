/** Keep the full internal ID in our DB, but send a short provider reference.
 * Hubnet's Telecel endpoint rejects longer values. The internal IDs are random
 * UUID-derived values, so the 12-character prefix remains suitable for lookup. */
export function hubnetReference(internalReference: string): string {
  return internalReference.slice(0, 12);
}

export function isInternalDeliveryReference(value: string): boolean {
  return /^DS[A-Fa-f0-9]{23}$/.test(value);
}

export function isHubnetDeliveryReference(value: string): boolean {
  return /^DS[A-Fa-f0-9]{10}$/.test(value);
}
