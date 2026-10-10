from django.core.management.base import BaseCommand
from reminders.services import generate_daily_reminders, dispatch_due_reminders


class Command(BaseCommand):
    help = 'Generates and dispatches due medication reminders'

    def handle(self, *args, **options):
        self.stdout.write("1. Generating daily reminders for active patients...")
        generated = generate_daily_reminders()
        self.stdout.write(self.style.SUCCESS(f"Generated {generated} new reminders."))

        self.stdout.write("2. Dispatching due reminders...")
        res = dispatch_due_reminders()
        self.stdout.write(self.style.SUCCESS(f"Dispatch summary: {res}"))
