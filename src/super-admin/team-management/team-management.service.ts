import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, UserStatus } from '../../generated/prisma/client';
import { StorageService } from '../../storage/storage.service';

@Injectable()
export class TeamManagementService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
  ) {}

  // ── Admin Stats ──────────────────────────────────────────────────────
  async getAdminStats(userId: string, userRole: string) {
    const totalAdmins = await this.prisma.user.count({
      where: { role: UserRole.admin },
    });

    const activeAdmins = await this.prisma.user.count({
      where: { role: UserRole.admin, status: UserStatus.active },
    });

    const pendingInvitations = await this.prisma.invitation.count({
      where: { status: 'pending', role: UserRole.admin },
    });

    return {
      totalAdmins,
      active: activeAdmins,
      pendingInvitations,
    };
  }
  // ── Admin List (super_admin বাদ) ─────────────────────────────────────
  async getAdminList(search?: string, status?: string) {
    return this.prisma.user.findMany({
      where: {
        role: UserRole.admin, // শুধু admin, super_admin বাদ
        ...(status && status !== 'all' ? { status: status as any } : {}),
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        avatarUrl: true,
        lastLoginAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // User Details by ID
  // User Details by ID
  async getUserDetailsById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        tenantId: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        employeeId: true,
        department: true,
        dateOfBirth: true,
        address: true,
        bio: true,
        hourlyRate: true,
        joinDate: true,
        avatarUrl: true,
        lastLoginAt: true,
        isExemptFromSubscription: true,
        createdAt: true,
        updatedAt: true,
        emergencyContacts: true,
        certifications: true,
        uploadedDocuments: {
          orderBy: { uploadedAt: 'desc' },
        },
        workScheduleAssignments: {
          include: { schedule: true },
        },
        timeAdjustments: {
          orderBy: { submittedAt: 'desc' },
          take: 30,
        },
        attendances: {
          orderBy: { date: 'desc' },
          take: 30,
          include: { sessions: true },
        },
        userSettings: {
          select: {
            language: true,
            timezone: true,
            dateFormat: true,
            currency: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Admin → assigned companies (CompanyMember)
    if (user.role === UserRole.admin) {
      const ownedCompanies = await this.prisma.company.findMany({
        where: { ownerId: userId },
        select: {
          id: true,
          name: true,
          industry: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const companies = ownedCompanies.map((c) => ({
        id: c.id,
        role: 'owner',
        joinedAt: c.createdAt,
        company: {
          id: c.id,
          name: c.name,
          industry: c.industry,
          isActive: c.isActive,
        },
      }));

      return { ...user, companies, projects: [] };
    }

    // Manager or Worker → assigned projects (ProjectMember)
    if (user.role === UserRole.manager || user.role === UserRole.worker) {
      const projects = await this.prisma.projectMember.findMany({
        where: { userId },
        select: {
          id: true,
          role: true,
          createdAt: true,
          project: {
            select: {
              id: true,
              name: true,
              status: true,
              startDate: true,
              endDate: true,
              progress: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return { ...user, projects, companies: [] };
    }

    return { ...user, companies: [], projects: [] };
  }

  // ── Update User Status ───────────────────────────────────────────────
  async updateUserStatus(userId: string, status: string) {
    const validStatuses = ['active', 'inactive', 'suspended'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException('Invalid status');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { status: status as any },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        status: true,
      },
    });
  }

  // ── Update User Details ───────────────────────────────────────────────
  async updateUserDetails(userId: string, data: any) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        fullName: data.fullName,
        role: data.role,
        phone: data.phone,
        hourlyRate: data.hourlyRate ? parseFloat(data.hourlyRate) : undefined,
      },
    });
  }

  // ── Manager Stats ────────────────────────────────────────────────────
  async getManagerStats(userId: string, userRole: string) {
    const adminFilter =
      userRole === UserRole.admin
        ? {
            projectMemberships: {
              some: { project: { company: { ownerId: userId } } },
            },
          }
        : {};

    const totalManagers = await this.prisma.user.count({
      where: { role: UserRole.manager, ...adminFilter },
    });

    const activeManagers = await this.prisma.user.count({
      where: {
        role: UserRole.manager,
        status: UserStatus.active,
        ...adminFilter,
      },
    });

    const managedProjects = await this.prisma.projectMember.findMany({
      where: {
        role: 'manager',
        ...(userRole === UserRole.admin
          ? { project: { company: { ownerId: userId } } }
          : {}),
      },
      select: { projectId: true },
      distinct: ['projectId'],
    });

    return {
      totalManagers,
      active: activeManagers,
      totalProjectsManaged: managedProjects.length,
    };
  }

  // ── Workforce Stats ──────────────────────────────────────────────────
  async getWorkforceStats(userId: string, userRole: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setHours(0, 0, 0, 0);

    const totalWorkforce = await this.prisma.user.count({
      where: { role: UserRole.worker, status: UserStatus.active },
    });

    const lastMonthWorkforce = await this.prisma.user.count({
      where: {
        role: UserRole.worker,
        status: UserStatus.active,
        createdAt: { lt: lastMonth },
      },
    });
    const workforceTrend = totalWorkforce - lastMonthWorkforce;

    const activeToday = await this.prisma.attendance.count({
      where: {
        date: { gte: today, lte: todayEnd },
        user: { role: UserRole.worker },
      },
    });

    const activeTodayPercent =
      totalWorkforce > 0 ? Math.round((activeToday / totalWorkforce) * 100) : 0;

    const onLeave = await this.prisma.leaveRequest.count({
      where: {
        status: 'approved',
        startDate: { lte: todayEnd },
        endDate: { gte: today },
      },
    });

    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    const onLeaveLastWeek = await this.prisma.leaveRequest.count({
      where: {
        status: 'approved',
        startDate: { lte: new Date(lastWeek.getTime() + 86400000) },
        endDate: { gte: lastWeek },
      },
    });
    const leaveTrend = onLeave - onLeaveLastWeek;

    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const totalAttendances = await this.prisma.attendance.count({
      where: {
        date: { gte: last30Days },
        user: { role: UserRole.worker },
      },
    });

    const totalExpectedAttendances = totalWorkforce * 30;
    const avgAttendance =
      totalExpectedAttendances > 0
        ? Math.round((totalAttendances / totalExpectedAttendances) * 1000) / 10
        : 0;

    const prevMonthAttendances = await this.prisma.attendance.count({
      where: {
        date: { gte: lastMonth, lt: last30Days },
        user: { role: UserRole.worker },
      },
    });
    const prevAvgAttendance =
      totalExpectedAttendances > 0
        ? Math.round((prevMonthAttendances / totalExpectedAttendances) * 1000) /
          10
        : 0;
    const attendanceTrend =
      Math.round((avgAttendance - prevAvgAttendance) * 10) / 10;

    return {
      totalWorkforce,
      workforceTrend:
        workforceTrend >= 0 ? `+${workforceTrend}` : `${workforceTrend}`,
      activeToday,
      activeTodayPercent: `${activeTodayPercent}%`,
      onLeave,
      leaveTrend: leaveTrend >= 0 ? `+${leaveTrend}` : `${leaveTrend}`,
      avgAttendance: `${avgAttendance}%`,
      attendanceTrend:
        attendanceTrend >= 0 ? `+${attendanceTrend}%` : `${attendanceTrend}%`,
    };
  }

  // ── Pending Invitations List ─────────────────────────────────────────
  async getPendingInvitations(
    userId: string,
    userRole: string,
    search?: string,
    role?: string,
  ) {
    const invitations = await this.prisma.invitation.findMany({
      where: {
        status: 'pending',
        ...(userRole === UserRole.super_admin ? {} : { senderId: userId }),
        ...(role ? { role: role as UserRole } : {}),
        ...(search
          ? {
              OR: [
                { email: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        sender: {
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      phone: inv.phone,
      role: inv.role,
      status: inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
      requestedBy: inv.sender,
    }));
  }

  // ── Manager List ─────────────────────────────────────────────────────────
  async getManagerList(
    search?: string,
    status?: string,
    userId?: string,
    userRole?: string,
  ) {
    return this.prisma.user.findMany({
      where: {
        role: UserRole.manager,
        ...(status && status !== 'all' ? { status: status as any } : {}),
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(userRole === UserRole.admin && userId
          ? {
              projectMemberships: {
                some: {
                  project: {
                    company: {
                      ownerId: userId,
                    },
                  },
                },
              },
            }
          : {}),
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        avatarUrl: true,
        lastLoginAt: true,
        projectMemberships: {
          select: {
            projectId: true,
            project: {
              select: { id: true, name: true },
            },
          },
          where: { role: 'manager' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Worker Documents CRUD ──────────────────────────────────────────
  async getWorkerDocuments(
    workerId: string,
    search?: string,
    category?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: workerId },
      select: {
        id: true,
        fullName: true,
        email: true,
        uploadedDocuments: {
          orderBy: { uploadedAt: 'desc' },
        },
        certifications: {
          orderBy: { issuedAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Worker not found');
    }

    const docs = user.uploadedDocuments.map((d) => ({
      id: d.id,
      name: d.fileName,
      category: d.fileType || 'Employment Document',
      date: d.uploadedAt ? d.uploadedAt.toISOString().split('T')[0] : 'Current',
      size: d.fileSizeMb ? `${d.fileSizeMb} MB` : '1.2 MB',
      status: 'verified',
      url: d.fileUrl,
      source: 'document',
      uploadedAt: d.uploadedAt,
    }));

    const certs = user.certifications.map((c) => ({
      id: c.id,
      name: `${c.name}.pdf`,
      category: 'Certification',
      date: c.issuedAt ? c.issuedAt.toISOString().split('T')[0] : 'Current',
      size: 'Verified',
      status: c.status || 'verified',
      url: c.documentUrl,
      source: 'certification',
      uploadedAt: c.issuedAt,
    }));

    let allDocs = [...docs, ...certs];

    if (search) {
      const q = search.toLowerCase();
      allDocs = allDocs.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.category.toLowerCase().includes(q),
      );
    }

    if (category && category !== 'all') {
      allDocs = allDocs.filter(
        (d) => d.category.toLowerCase() === category.toLowerCase(),
      );
    }

    return allDocs;
  }

  async uploadWorkerDocument(
    workerId: string,
    file?: Express.Multer.File,
    category?: string,
    customName?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: workerId },
      include: {
        companyMembers: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Worker not found');
    }

    if (!file) {
      throw new BadRequestException('File is required');
    }

    const fileUrl = await this.storageService.uploadFile(
      file,
      'worker-documents',
    );
    const fileSizeMb = Math.round((file.size / (1024 * 1024)) * 100) / 100;
    const documentName = customName?.trim() || file.originalname;
    const documentCategory = category?.trim() || 'General Document';

    // Store in Prisma Document table
    const doc = await this.prisma.document.create({
      data: {
        uploadedBy: workerId,
        companyId: user.companyMembers?.[0]?.companyId || undefined,
        fileName: documentName,
        fileUrl,
        fileType: documentCategory,
        fileSizeMb,
      },
    });

    // If category is Certification, also create/sync a UserCertification record
    if (documentCategory.toLowerCase().includes('cert')) {
      await this.prisma.userCertification
        .create({
          data: {
            userId: workerId,
            name: documentName.replace(/\.[^/.]+$/, ''),
            documentUrl: fileUrl,
            issuedAt: new Date(),
            status: 'active',
          },
        })
        .catch(() => {});
    }

    return {
      id: doc.id,
      name: doc.fileName,
      category: doc.fileType,
      date: doc.uploadedAt.toISOString().split('T')[0],
      size: `${doc.fileSizeMb} MB`,
      status: 'verified',
      url: doc.fileUrl,
      source: 'document',
      uploadedAt: doc.uploadedAt,
    };
  }

  async deleteWorkerDocument(workerId: string, documentId: string) {
    // Check if in Document table
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, uploadedBy: workerId },
    });

    if (doc) {
      if (doc.fileUrl) {
        await this.storageService.deleteFile(doc.fileUrl).catch(() => {});
      }
      await this.prisma.document.delete({ where: { id: documentId } });
      return { message: 'Document deleted successfully' };
    }

    // Check if in UserCertification table
    const cert = await this.prisma.userCertification.findFirst({
      where: { id: documentId, userId: workerId },
    });

    if (cert) {
      if (cert.documentUrl) {
        await this.storageService.deleteFile(cert.documentUrl).catch(() => {});
      }
      await this.prisma.userCertification.delete({ where: { id: documentId } });
      return { message: 'Certification document deleted successfully' };
    }

    throw new NotFoundException('Document not found');
  }
}
