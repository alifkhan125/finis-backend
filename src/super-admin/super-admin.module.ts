import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { SuperAdminDashboardController } from './dashboard/dashboard.controller';
import { SuperAdminDashboardService } from './dashboard/dashboard.service';
import { SuperAdminCompaniesController } from './company/companies.controller';
import { SuperAdminCompaniesService } from './company/companies.service';
import { SuperAdminUsersController } from './users/users.controller';
import { SuperAdminUsersService } from './users/users.service';
import { SuperAdminSwitchController } from './switch/switch.controller';
import { SuperAdminSwitchService } from './switch/switch.service';
import { SuperAdminProjectController } from './projects/project.controller';
import { SuperAdminProjectService } from './projects/project.service';
import { TeamManagementController } from './team-management/team-management.controller';
import { TeamManagementService } from './team-management/team-management.service';
import { PayrollManagementController } from './payroll-management/payroll-management.controller';
import { PayrollManagementService } from './payroll-management/payroll-management.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { SubscriptionModule } from './subscription/subscription.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, SubscriptionModule, AuthModule, StorageModule],
  controllers: [
    SuperAdminDashboardController,
    SuperAdminCompaniesController,
    SuperAdminProjectController,
    TeamManagementController,
    PayrollManagementController,
    ReportsController,
    SuperAdminUsersController,
    SuperAdminSwitchController,
  ],
  providers: [
    SuperAdminDashboardService,
    SuperAdminCompaniesService,
    SuperAdminUsersService,
    SuperAdminSwitchService,
    SuperAdminProjectService,
    TeamManagementService,
    PayrollManagementService,
    ReportsService,
  ],
  exports: [],
})
export class SuperAdminModule {}
