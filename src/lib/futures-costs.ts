/** Index futures tax: round each contract's side to a whole TWD, then multiply lots. */
export function futuresTax(price: number, multiplier: number, taxRate: number, quantity = 1) {
    return Math.round(price * multiplier * taxRate) * quantity;
}
