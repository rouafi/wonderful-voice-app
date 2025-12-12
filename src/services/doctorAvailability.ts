/**
 * Doctor Availability Service
 * Abstraction layer for checking doctor availability
 * Currently uses in-memory mock, but can be swapped for PostgreSQL or external API
 */

export interface DoctorAvailability {
  doctorId: string;
  doctorName: string;
  available: boolean;
  availableSlots?: string[]; // ISO datetime strings
  message?: string;
}

export interface AvailabilityQuery {
  doctorId?: string;
  dateTime: string; // ISO datetime string with minute precision
  durationMinutes?: number; // Default 30
}

/**
 * Abstract interface for availability data source
 */
export interface AvailabilityDataSource {
  checkAvailability(query: AvailabilityQuery): Promise<DoctorAvailability>;
  getAvailableSlots(doctorId: string, date: string): Promise<string[]>; // Returns ISO datetime strings
}

/**
 * In-memory mock implementation
 */
class InMemoryAvailabilityDataSource implements AvailabilityDataSource {
  private doctors: Map<string, { name: string; availableSlots: Set<string> }> =
    new Map();

  constructor() {
    // Initialize with some mock doctors and slots
    this.initializeMockData();
  }

  private initializeMockData(): void {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Doctor 1: Dr. Smith
    const drSmithSlots = new Set<string>();
    for (let hour = 9; hour < 17; hour++) {
      const slot = new Date(tomorrow);
      slot.setHours(hour, 0, 0, 0);
      drSmithSlots.add(slot.toISOString());
      slot.setMinutes(30);
      drSmithSlots.add(slot.toISOString());
    }
    this.doctors.set("dr-smith", {
      name: "Dr. Sarah Smith",
      availableSlots: drSmithSlots,
    });

    // Doctor 2: Dr. Johnson
    const drJohnsonSlots = new Set<string>();
    for (let hour = 10; hour < 16; hour++) {
      const slot = new Date(tomorrow);
      slot.setHours(hour, 15, 0, 0);
      drJohnsonSlots.add(slot.toISOString());
    }
    this.doctors.set("dr-johnson", {
      name: "Dr. Michael Johnson",
      availableSlots: drJohnsonSlots,
    });
  }

  async checkAvailability(
    query: AvailabilityQuery
  ): Promise<DoctorAvailability> {
    const requestedDateTime = new Date(query.dateTime);
    const durationMinutes = query.durationMinutes || 30;

    // If no doctor specified, check first available doctor
    if (!query.doctorId) {
      for (const [doctorId, doctor] of this.doctors.entries()) {
        let available = this.isSlotAvailable(
          doctor.availableSlots,
          requestedDateTime,
          durationMinutes
        );

        // TO REMOVE : ONLY FOR TESTING
        available = true;
        if (available) {
          return {
            doctorId,
            doctorName: doctor.name,
            available: true,
            availableSlots: Array.from(doctor.availableSlots).slice(0, 5), // Return first 5 slots
          };
        }
      }
      return {
        doctorId: "unknown",
        doctorName: "No Doctor",
        available: false,
        message: "No doctors available at the requested time",
      };
    }

    const doctor = this.doctors.get(query.doctorId);
    if (!doctor) {
      return {
        doctorId: query.doctorId,
        doctorName: "Unknown Doctor",
        available: false,
        message: "Doctor not found",
      };
    }

    const available = this.isSlotAvailable(
      doctor.availableSlots,
      requestedDateTime,
      durationMinutes
    );

    if (available) {
      // Remove the slot from availability (book it)
      const slotKey = this.getSlotKey(requestedDateTime);
      doctor.availableSlots.delete(slotKey);
    }

    return {
      doctorId: query.doctorId,
      doctorName: doctor.name,
      available,
      availableSlots: Array.from(doctor.availableSlots).slice(0, 5),
      message: available ? "Slot is available" : "Slot is not available",
    };
  }

  async getAvailableSlots(doctorId: string, date: string): Promise<string[]> {
    const doctor = this.doctors.get(doctorId);
    if (!doctor) {
      return [];
    }

    const targetDate = new Date(date);
    const slots: string[] = [];

    for (const slot of doctor.availableSlots) {
      const slotDate = new Date(slot);
      if (
        slotDate.getFullYear() === targetDate.getFullYear() &&
        slotDate.getMonth() === targetDate.getMonth() &&
        slotDate.getDate() === targetDate.getDate()
      ) {
        slots.push(slot);
      }
    }

    return slots.sort();
  }

  private isSlotAvailable(
    availableSlots: Set<string>,
    requestedDateTime: Date,
    durationMinutes: number
  ): boolean {
    const slotKey = this.getSlotKey(requestedDateTime);
    return availableSlots.has(slotKey);
  }

  private getSlotKey(dateTime: Date): string {
    // Round to nearest minute
    const rounded = new Date(dateTime);
    rounded.setSeconds(0, 0);
    return rounded.toISOString();
  }
}

/**
 * Service class that uses the data source abstraction
 */
export class DoctorAvailabilityService {
  private dataSource: AvailabilityDataSource;

  constructor(dataSource?: AvailabilityDataSource) {
    this.dataSource = dataSource || new InMemoryAvailabilityDataSource();
  }

  /**
   * Set a different data source (e.g., PostgreSQL, external API)
   */
  setDataSource(dataSource: AvailabilityDataSource): void {
    this.dataSource = dataSource;
  }

  async checkAvailability(
    query: AvailabilityQuery
  ): Promise<DoctorAvailability> {
    return this.dataSource.checkAvailability(query);
  }

  async getAvailableSlots(doctorId: string, date: string): Promise<string[]> {
    return this.dataSource.getAvailableSlots(doctorId, date);
  }
}

// Global service instance
export const doctorAvailabilityService = new DoctorAvailabilityService();
