import { Component, OnInit } from '@angular/core';
import { ContentService } from '../content.service';

@Component({
  selector: 'app-navbar',
  templateUrl: './navbar.component.html',
  styleUrls: ['./navbar.component.css']
})
export class NavbarComponent implements OnInit {

  descriptors: Array<string> = ['Home', 'About', 'Projects', 'Contact Me'];

  constructor(private _contentService: ContentService) { }

  ngOnInit() {
  }

  makeActiveDescriptor( descriptor:string ):void {
  	this._contentService.updateActive(descriptor);
  }
}
