import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';

import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';

import { CompanyController } from './company/company.controller';
import { CompanyService } from './company/company.service';

import { ProjectController } from './project/project.controller';
import { ProjectService } from './project/project.service';

import { ProfileController } from './profile/profile.controller';
import { ProfileService } from './profile/profile.service';

import { GeofencingGateway } from './project/geofencing.gateway';
import { TeamController } from './project/team.controller';

import { TaskController } from './task/task.controller';
import { SubTaskController } from './task/subtask.controller';
import { TaskService } from './task/task.service';

import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { PayrollController } from './payroll/payroll.controller';
import { PayrollService } from './payroll/payroll.service';
import { AdminReportsController } from './reports/reports.controller';
import { ProjectInvoicesController } from './invoices/invoices.controller';
import { ProjectInvoicesService } from './invoices/invoices.service';
import { ReimbursementExpensesController } from './reimbursement-expenses/reimbursement-expenses.controller';
import { ReimbursementExpensesService } from './reimbursement-expenses/reimbursement-expenses.service';
import { ReportsService } from '../super-admin/reports/reports.service';

@Module({
  imports: [PrismaModule, ConfigModule, NotificationsModule, StorageModule],
  controllers: [
    DashboardController,
    CompanyController,
    ProjectController,
    TeamController,
    ProfileController,
    TaskController,
    SubTaskController,
    InventoryController,
    PayrollController,
    AdminReportsController,
    ProjectInvoicesController,
    ReimbursementExpensesController,
  ],
  providers: [
    DashboardService,
    CompanyService,
    ProjectService,
    ProfileService,
    GeofencingGateway,
    TaskService,
    InventoryService,
    PayrollService,
    ReportsService,
    ProjectInvoicesService,
    ReimbursementExpensesService,
  ],
  exports: [
    CompanyService,
    ProjectService,
    InventoryService,
    PayrollService,
    GeofencingGateway,
  ],
})
export class AdminModule {}
