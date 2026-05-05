const Leave = require('../models/Leave');
const User = require('../models/User');

// POST /api/leaves — apply leave
exports.applyLeave = async (req, res) => {
  try {
    const user = req.user;

    // Admin cannot apply leave — they act as HR/system managers only
    if (user.role === 'Admin') {
      return res.status(403).json({ message: 'Admin users cannot apply for leave' });
    }

    const { leaveType, fromDate, toDate, duration, comments } = req.body;

    // Determine if there's a document upload (handled by multer)
    let documentData = { originalName: null, url: null };
    let documentStatus = 'None';

    if (req.file) {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      documentData = {
        originalName: req.file.originalname,
        url: `${baseUrl}/uploads/${req.file.filename}`,
      };
      documentStatus = 'Pending';
    }

    const leave = await Leave.create({
      employee: user._id,
      employeeName: user.name,
      employeeId: user.employeeId,
      leaveType,
      fromDate,
      toDate,
      duration,
      comments: comments || '',
      status: 'Pending',
      managerComment: '',
      document: documentData,
      documentStatus,
      appliedDate: new Date(),
      subUnit: user.subUnit || user.department || 'Engineering',
    });

    // Conflict check — same team, overlapping dates
    const conflicts = await Leave.find({
      employee: { $ne: user._id },
      status: { $nin: ['Rejected', 'Cancelled'] },
      fromDate: { $lte: new Date(toDate) },
      toDate: { $gte: new Date(fromDate) },
    }).populate('employee', 'team employeeId');

    const teamConflicts = conflicts.filter(
      (l) => l.employee && l.employee.team && l.employee.team === user.team
    );

    res.status(201).json({
      data: leave,
      conflict: teamConflicts.length > 0,
      conflictCount: teamConflicts.length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/leaves — role-filtered list
exports.getLeaves = async (req, res) => {
  try {
    const user = req.user;
    let query = {};

    if (user.role === 'Employee') {
      query.employee = user._id;
    }
    // Manager and Admin: see all leaves (no filter)

    const leaves = await Leave.find(query).sort({ appliedDate: -1 });

    // Map to frontend-compatible shape
    const data = leaves.map((l) => ({
      id: l._id,
      employeeId: l.employeeId,
      employeeName: l.employeeName,
      leaveType: l.leaveType,
      fromDate: l.fromDate.toISOString().split('T')[0],
      toDate: l.toDate.toISOString().split('T')[0],
      duration: l.duration.toFixed(2),
      status: l.status,
      comments: l.comments,
      managerComment: l.managerComment,
      appliedDate: l.appliedDate.toISOString().split('T')[0],
      document: l.document?.originalName ? { name: l.document.originalName, url: l.document.url } : null,
      documentStatus: l.documentStatus,
    }));

    res.json({ data });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/leaves/:id — approve/reject
exports.updateLeaveStatus = async (req, res) => {
  try {
    const { status, managerComment } = req.body;
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be Approved or Rejected' });
    }

    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: 'Leave not found' });
    if (leave.status !== 'Pending') {
      return res.status(400).json({ message: 'Only pending leaves can be updated' });
    }

    leave.status = status;
    leave.managerComment = managerComment || '';
    leave.reviewedBy = req.user._id;
    leave.reviewedAt = new Date();
    await leave.save();

    res.json({ data: leave });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/leaves/:id/document-verify — verify or reject document (independent of leave)
exports.verifyDocument = async (req, res) => {
  try {
    const { documentStatus } = req.body; // 'Verified' or 'Rejected'
    if (!['Verified', 'Rejected'].includes(documentStatus)) {
      return res.status(400).json({ message: 'documentStatus must be Verified or Rejected' });
    }

    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: 'Leave not found' });
    if (leave.documentStatus !== 'Pending') {
      return res.status(400).json({ message: 'Document is not in Pending state' });
    }

    leave.documentStatus = documentStatus;
    await leave.save();

    res.json({ data: leave });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/leaves/:id — cancel if pending
exports.cancelLeave = async (req, res) => {
  try {
    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: 'Leave not found' });

    // Only the owner or admin can cancel
    if (leave.employee.toString() !== req.user._id.toString() && req.user.role !== 'Admin') {
      return res.status(403).json({ message: 'Not authorized to cancel this leave' });
    }
    if (leave.status !== 'Pending') {
      return res.status(400).json({ message: 'Only pending leaves can be cancelled' });
    }

    leave.status = 'Cancelled';
    await leave.save();

    res.json({ data: leave });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/leaves/conflict-check?fromDate=...&toDate=...
exports.conflictCheck = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    if (!fromDate || !toDate) {
      return res.status(400).json({ message: 'fromDate and toDate required' });
    }

    const user = req.user;
    const conflicts = await Leave.find({
      employee: { $ne: user._id },
      status: { $nin: ['Rejected', 'Cancelled'] },
      fromDate: { $lte: new Date(toDate) },
      toDate: { $gte: new Date(fromDate) },
    }).populate('employee', 'team employeeId name');

    const teamConflicts = conflicts
      .filter((l) => l.employee && l.employee.team && l.employee.team === user.team)
      .map((l) => ({
        employeeName: l.employeeName,
        leaveType: l.leaveType,
        fromDate: l.fromDate.toISOString().split('T')[0],
        toDate: l.toDate.toISOString().split('T')[0],
      }));

    res.json({ conflict: teamConflicts.length > 0, conflicts: teamConflicts });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};