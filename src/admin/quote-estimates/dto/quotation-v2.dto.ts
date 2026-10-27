import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export class QuotationTextRunDto {
  @IsString() @MaxLength(20000) text!: string;
  @IsOptional() @IsBoolean() bold?: boolean;
  @IsOptional() @IsBoolean() italic?: boolean;
  @IsOptional() @IsBoolean() underline?: boolean;
}
export class QuotationBlockDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => QuotationTextRunDto) runs!: QuotationTextRunDto[];
  @IsOptional() @IsBoolean() heading?: boolean;
  @IsOptional() @IsBoolean() bullet?: boolean;
}
export class QuotationUnitDto {
  @IsString() @MaxLength(100) id!: string;
  @IsString() @MaxLength(200) label!: string;
}
export class QuotationFloorDto {
  @IsString() @MaxLength(200) label!: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => QuotationUnitDto) units!: QuotationUnitDto[];
}
export class QuotationServiceDto {
  @IsString() @MaxLength(500) title!: string;
  @IsString() @MaxLength(10000) description!: string;
  @IsNumber() @Min(0) rate!: number;
  @IsNumber() @Min(0) hours!: number;
  @IsNumber() @Min(0) hourlyExtra!: number;
  @IsNumber() @Min(0) oneTime!: number;
  @IsArray() @ArrayMaxSize(20000) @IsString({ each: true }) unitIds!: string[];
}
export class QuotationV2Dto {
  @IsString() @MaxLength(500) project!: string;
  @IsString() @MaxLength(500) company!: string;
  @IsString() @MaxLength(500) client!: string;
  @IsString() @MaxLength(2000) address!: string;
  @IsString() @MaxLength(200) phone!: string;
  @IsString() @MaxLength(320) email!: string;
  @IsString() @MaxLength(200) projectType!: string;
  @IsString() @MaxLength(200) propertyType!: string;
  @IsString() @MaxLength(200) buildingType!: string;
  @IsString() @MaxLength(100) start!: string;
  @IsString() @MaxLength(100) end!: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => QuotationBlockDto) details!: QuotationBlockDto[];
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => QuotationFloorDto) floors!: QuotationFloorDto[];
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => QuotationServiceDto) services!: QuotationServiceDto[];
}
export class EmailQuotationV2Dto extends QuotationV2Dto {
  @IsEmail() declare email: string;
}
