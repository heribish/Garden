/**
 * Order lifecycle — pay-before-delivery (M-Pesa STK):
 *   placed → payment_pending → paid → new → preparing → ready_for_pickup → driver… → delivered
 * Shop packs only after `new` (payment confirmed). Driver is offered only after ready_for_pickup.
 */
const transitions = {
  placed: ["payment_pending", "cancelled"],
  payment_pending: ["paid", "cancelled"],
  paid: ["new"],
  new: ["preparing", "declined"],
  preparing: ["ready_for_pickup", "cancelled"],
  ready_for_pickup: ["driver_en_route_pickup", "cancelled"],
  driver_en_route_pickup: ["driver_en_route_delivery", "cancelled"],
  driver_en_route_delivery: ["delivered", "cancelled"],
  delivered: [],
  declined: [],
  cancelled: [],
};

export function canTransition(from, to) {
  return transitions[from]?.includes(to) ?? false;
}

export function transitionOrder(order, to) {
  if (!canTransition(order.status, to)) {
    throw new Error(`Invalid transition ${order.status} -> ${to}`);
  }
  order.status = to;
  order.updated_at = new Date().toISOString();
  return order;
}
