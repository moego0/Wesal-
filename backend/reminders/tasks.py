from celery import shared_task
from .services import generate_daily_reminders, dispatch_due_reminders


@shared_task(name='reminders.tasks.generate_reminders_task')
def generate_reminders_task():
    count = generate_daily_reminders()
    return f"Generated {count} reminders."


@shared_task(name='reminders.tasks.dispatch_reminders_task')
def dispatch_reminders_task():
    res = dispatch_due_reminders(batch_size=100)
    return res
