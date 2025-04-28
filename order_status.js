class MyOrderStatus {
  constructor(state, statusCode) {
    this.state = state;
    this.statusCode = statusCode;
  }

  static fromStatusCode(code) {
    const found = Status.values.find(status => status.statusCode === code);
    if (!found) throw new Error(`Unknown status code: ${code}`);
    return found;
  }

  static fromState(state) {
    const found = Status.values.find(status => status.state === state);
    if (!found) throw new Error(`Unknown state: ${state}`);
    return found;
  }
}

const Status = {
  scWorkInProgress: new MyOrderStatus('Service Center WIP', 'sc_wip'),
  orderCart: new MyOrderStatus('Cart', 'add_to_cart'),
  technicianAssigned: new MyOrderStatus('Assign Technician', 'technician_assigned'),
  technicianAccepted: new MyOrderStatus('Technician Accepted', 'technician_accepted'),
  scReassigned: new MyOrderStatus('Service Center Reassigned', 'sc_reassigned'),
  scAssigned: new MyOrderStatus('Service Center Assigned', 'sc_assigned'),
  technicianRejected: new MyOrderStatus('Technician Rejected', 'technician_rejected'),
  cancelByCustomer: new MyOrderStatus('Order Cancelled by Customer', 'order_cancelled_by_customer'),
  technicianReassigned: new MyOrderStatus('Technician Reassigned', 'technician_reassigned'),
  orderPlaced: new MyOrderStatus('Order Placed', 'order_placed'),
  orderResolved: new MyOrderStatus('Order Resolved', 'sc_order_resolved'),
  refundSent: new MyOrderStatus('Refund Sent', 'refund_sent'),
  partsApproved: new MyOrderStatus('Parts approved', 'parts_approved'),
  refundInitiated: new MyOrderStatus('Refund Initiated', 'refund_initiated'),
  technicianReachedLocation: new MyOrderStatus('Technician reached the location', 'technician_on_location'),
  partsApprovalPending: new MyOrderStatus('Parts Request', 'parts_approval_pending'),
  technicianWorking: new MyOrderStatus('Technician WIP', 'technician_working'),
  refundReceived: new MyOrderStatus('Refund Received by Customer', 'refund_received'),
  orderScheduled: new MyOrderStatus('Order Scheduled', 'order_scheduled'),
  scRejected: new MyOrderStatus('Service Centre rejected', 'sc_rejected'),
  technicianWorkCompleted: new MyOrderStatus('Work Completed', 'technician_work_completed'),
  generalStatus: new MyOrderStatus('General/Info.', 'general'),
  partDispatched: new MyOrderStatus('Part Dispatched', 'parts_dispatched'),
  partOnTheWay: new MyOrderStatus('Part On the Way', 'parts_on_the_way'),
  partDelivered: new MyOrderStatus('Part Delivered', 'part_delivered'),
  partHandoverToTechnician: new MyOrderStatus('Parts Handover to Technician', 'parts_handover_to_tecnician'),
  defectivePartPickup: new MyOrderStatus('Defective Parts Pickup', 'defective_pickup'),

  values: [] // populated below
};

// populate Status.values
Status.values = Object.values(Status).filter(v => v instanceof MyOrderStatus);

// Exports (if using module system)
module.exports = { MyOrderStatus, Status };
